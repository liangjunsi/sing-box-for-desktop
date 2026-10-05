import { AccountApi, AccountError } from "./accountApi";
import type { AccountSession, CompactState } from "./contracts";
import { nodeConfig, selectConfig } from "./config";

export interface SavedAccount { session: AccountSession; profileId?: string; selected: string; lastUpdated?: number }
export interface AccountDependencies {
  load(): Promise<SavedAccount | null>;
  save(account: SavedAccount | null): Promise<boolean>;
  loadSelection?(userId: string): string;
  saveSelection?(userId: string, selected: string): void;
  cleanup(keep?: string): Promise<void>;
  sync(session: AccountSession, id?: string): Promise<{ id: string; content: string; updated: number; notice?: string }>;
  read(id: string): Promise<string>;
  start(content: string): Promise<void>;
  stop(): Promise<void>;
  select(group: string, tag: string): Promise<void>;
  running(): boolean;
  changed(state: CompactState): void;
}

export class CompactController {
  readonly state: CompactState;
  private account: SavedAccount | null = null;
  private remember = false;
  private content = "";
  private activeGroup = "";
  private activeNodes: string[] = [];
  private owned = false;
  private verifiedAt = 0;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly api: AccountApi, private readonly deps: AccountDependencies) {
    this.state = { configured: !!api.baseURL, user: null, nodes: [], selected: "", phase: "idle", loading: false, error: "", notice: "", upload: 0, download: 0 };
  }
  private emit() { this.deps.changed({ ...this.state, nodes: [...this.state.nodes] }); }
  private operation<T>(action: () => Promise<T>): Promise<T> {
    const result = this.queue.catch(() => {}).then(async () => {
      this.state.loading = true; this.state.error = ""; this.emit();
      try { return await action(); }
      catch (error) {
        this.state.error = error instanceof AccountError ? error.message : "操作失败，请检查服务或网络后重试";
        throw new Error(this.state.error);
      } finally { this.state.loading = false; this.emit(); }
    });
    this.queue = result; return result;
  }
  async restore(): Promise<void> {
    await this.operation(async () => {
      this.account = await this.deps.load(); this.remember = !!this.account;
      await this.deps.cleanup(this.account?.profileId);
      if (!this.account) return;
      try { this.account.session = await this.api.session(this.account.session); this.verifiedAt = performance.now(); }
      catch (error) {
        if (error instanceof AccountError && error.invalidSession) { await this.clear(); this.state.error = error.message; return; }
        this.state.notice = "暂时无法验证登录，显示本账号缓存；连接前将重新验证";
      }
      this.state.user = this.account.session.user;
      this.state.lastUpdated = this.account.lastUpdated;
      if (this.account.profileId) {
        try { this.setContent(await this.deps.read(this.account.profileId)); }
        catch { this.state.error = "节点缓存不可用，请更新订阅"; }
      }
      if (!this.state.notice) await this.refreshInternal();
    });
  }
  login(account: string, password: string, remember: boolean): Promise<void> {
    return this.operation(async () => {
      const session = await this.api.login(account, password);
      await this.clear();
      this.account = { session, selected: this.deps.loadSelection?.(session.user.id) ?? "" }; this.remember = remember;
      this.verifiedAt = performance.now();
      this.state.user = session.user;
      await this.persist();
      await this.refreshInternal();
    });
  }
  private setContent(content: string) {
    const preferred = this.account?.selected ?? "";
    const model = nodeConfig(content, preferred);
    this.content = content; this.state.nodes = model.nodes; this.state.selected = model.selected;
    if (preferred && preferred !== model.selected) this.state.notice = "上次选择的节点已移除，已选择可用节点";
    if (this.account) this.account.selected = model.selected;
  }
  private async persist() {
    if (this.account?.selected) this.deps.saveSelection?.(this.account.session.user.id, this.account.selected);
    const saved = await this.deps.save(this.remember ? this.account : null);
    if (this.remember && !saved) {
      this.remember = false;
      this.state.notice = "系统加密不可用，本次登录仅在当前运行期间保留";
    }
  }
  private async validate() {
    if (!this.account) throw new AccountError("请先登录");
    try {
      this.account.session = await this.api.session(this.account.session);
      this.verifiedAt = performance.now();
      await this.persist();
    } catch (error) {
      if (error instanceof AccountError && error.invalidSession) await this.clear();
      throw error;
    }
  }
  private async refreshInternal() {
    if (!this.account) throw new AccountError("请先登录");
    if (["expired", "quota_exhausted"].includes(this.account.session.subscriptionStatus ?? "")) {
      await this.disconnectInternal();
      await this.deps.cleanup(); this.account.profileId = undefined; this.content = "";
      Object.assign(this.state, { nodes: [], selected: "", error: "订阅已到期或额度耗尽" });
      await this.persist(); return;
    }
    try {
      const result = await this.deps.sync(this.account.session, this.account.profileId);
      if (result.notice) this.state.notice = result.notice;
      else if (/^已跳过 \d+ 个不兼容节点/.test(this.state.notice)) this.state.notice = "";
      this.account.profileId = result.id; this.setContent(result.content);
      this.state.lastUpdated = result.updated;
      this.account.lastUpdated = result.updated;
      if (this.owned && this.deps.running()) this.state.notice = "订阅已更新，下次连接生效";
      await this.persist();
    } catch (error) {
      if (error instanceof AccountError && error.invalidSession) { await this.clear(); throw error; }
      this.state.error = "已登录，节点加载失败；可重试更新订阅";
    }
  }
  refresh(): Promise<void> { return this.operation(async () => { await this.validate(); await this.refreshInternal(); }); }
  connect(): Promise<void> {
    return this.operation(async () => {
      await this.validate();
      this.requireEligible();
      if (this.deps.running()) throw new AccountError("已有服务运行，请先断开或在高级管理中处理");
      if (!this.content || !this.state.selected) throw new AccountError("请先加载可用节点");
      this.state.phase = "connecting"; this.emit(); this.owned = true;
      try {
        const content = selectConfig(this.content, this.state.selected);
        this.activeGroup = nodeConfig(content).group;
        this.activeNodes = nodeConfig(content).nodes.map((node) => node.tag);
        await this.deps.start(content); this.state.phase = "connected";
      } catch {
        try { await this.deps.stop(); this.owned = false; } catch { /* Keep ownership so cleanup can be retried. */ }
        this.state.phase = "failed";
        throw new AccountError("连接失败，请检查守护进程与系统代理权限");
      }
    });
  }
  private async disconnectInternal() {
    if (this.owned) {
      this.state.phase = "disconnecting"; this.emit();
      await this.deps.stop(); this.owned = false;
    }
    this.state.phase = "idle"; this.state.upload = 0; this.state.download = 0;
  }
  disconnect(): Promise<void> { return this.operation(() => this.disconnectInternal()); }
  select(tag: string): Promise<void> {
    return this.operation(async () => {
      if (!this.state.nodes.some((node) => node.tag === tag)) throw new AccountError("节点已不存在，请更新列表");
      if (this.owned && this.deps.running()) {
        if (!this.activeNodes.includes(tag)) throw new AccountError("此节点来自新订阅，请断开后重新连接");
        if (!this.activeGroup) throw new AccountError("当前配置需要断开后切换节点");
        await this.deps.select(this.activeGroup, tag);
      }
      this.state.selected = tag;
      if (this.account) this.account.selected = tag;
      await this.persist();
    });
  }
  private requireEligible() {
    const status = this.account?.session.subscriptionStatus;
    if (status && status !== "active") throw new AccountError(status === "pending" ? "节点等待同步，请稍后更新订阅" : "订阅已到期或额度耗尽");
  }
  verify(now = performance.now()): Promise<void> {
    return this.operation(async () => {
      if (!this.account) return;
      try { await this.validate(); if (this.owned) { try { this.requireEligible(); } catch (error) { await this.disconnectInternal(); throw error; } } }
      catch (error) {
        if (this.owned && now - this.verifiedAt >= 120_000) await this.disconnectInternal();
        throw error;
      }
    });
  }
  private async clear() {
    await this.disconnectInternal();
    await this.deps.save(null); await this.deps.cleanup();
    this.account = null; this.content = ""; this.remember = false; this.activeGroup = "";
    Object.assign(this.state, { user: null, nodes: [], selected: "", notice: "", lastUpdated: undefined });
  }
  logout(): Promise<void> { return this.operation(async () => { if (this.account) await this.api.logout(this.account.session).catch(() => {}); await this.clear(); }); }
  shutdown(): Promise<void> { return this.operation(() => this.disconnectInternal()); }
  reconcile(running: boolean, proxyEnabled: boolean, upload = 0, download = 0) {
    if (this.state.loading) return;
    if (this.owned && this.state.phase === "connected" && (!running || !proxyEnabled)) {
      const reason = running
        ? "系统代理已被关闭或被其他软件切换（例如 v2rayN），本连接已断开，请只开启一个代理后重试"
        : "代理服务已停止，已尝试恢复系统代理，请断开后重试；详细原因可在高级管理的日志中查看";
      this.state.phase = "failed";
      void this.operation(async () => {
        try { await this.disconnectInternal(); }
        finally { this.state.phase = "failed"; this.state.error = reason; }
      }).catch(() => {});
    }
    this.state.upload = this.state.phase === "connected" ? upload : 0;
    this.state.download = this.state.phase === "connected" ? download : 0;
    this.emit();
  }
}
