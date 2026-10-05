import { app, BrowserWindow, ipcMain, safeStorage, Menu } from "electron";
import type { Rectangle } from "electron";
import { readFile, writeFile, rename, unlink, mkdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { configuredAccountApi } from "./developmentAccount";
import type { DevelopmentAccountOptions } from "./developmentAccount";
import { CUSTOM_CALL, CUSTOM_CHANGED } from "./contracts";
import { fitCompactPage } from "./windows";
import { CompactController } from "./controller";
import type { SavedAccount } from "./controller";
import { AccountError, secureURL } from "./accountApi";
import { nodeConfig } from "./config";
import { callProfileOperation, fetchRemoteContent, startServiceWithContent, selectProfile, profilesState } from "../../main/profiles";
import { managedService, startedService } from "../../main/daemon";
import { applicationService } from "../../main/worker";
import { daemonState } from "../../main/state";
import { Preference } from "../../main/database";
import { ServiceStatus_Type } from "../../shared/gen/daemon/started_service_pb";
import type { ProfileMetadata } from "../../shared/ipc";
import { parseProxySnapshot, readWindowsProxy, writeWindowsProxy, systemProxyConfig } from "./windowsProxy";
import type { ProxySnapshot } from "./windowsProxy";

const deviceIdentity = new Preference<string>("custom_device_id", crypto.randomUUID(), (value) => { if (typeof value !== "string" || !/^[0-9a-f-]{36}$/i.test(value)) throw new Error("invalid device identity"); return value; });
const profileIds = new Preference<string[]>("custom_account_profile_ids", [], (value) => {
  if (!Array.isArray(value) || !value.every((id) => typeof id === "string")) throw new Error("invalid account profiles");
  return value;
});
function encryptionAvailable() {
  return safeStorage.isEncryptionAvailable() && (process.platform !== "linux" || safeStorage.getSelectedStorageBackend() !== "basic_text");
}
const nodeSelections = new Preference<Record<string, string>>("custom_account_node_selections", {}, (value) => {
  if (!value || typeof value !== "object" || Array.isArray(value) || !Object.values(value).every((tag) => typeof tag === "string")) throw new Error("invalid node selections");
  return value as Record<string, string>;
});
function sessionPath() { return join(app.getPath("userData"), "custom-account.enc"); }
async function save(account: SavedAccount | null): Promise<boolean> {
  if (!account || !encryptionAvailable()) {
    await unlink(sessionPath()).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
    return !account;
  }
  await mkdir(app.getPath("userData"), { recursive: true });
  const temporary = `${sessionPath()}.tmp`;
  try { await writeFile(temporary, safeStorage.encryptString(JSON.stringify(account)), { mode: 0o600 }); await rename(temporary, sessionPath()); }
  finally { await unlink(temporary).catch(() => {}); }
  return true;
}
async function load(): Promise<SavedAccount | null> {
  if (!encryptionAvailable()) return null;
  try {
    const value = JSON.parse(safeStorage.decryptString(await readFile(sessionPath()))) as SavedAccount;
    if (!value?.session || typeof value.session.accessToken !== "string" || typeof value.session.expiresAt !== "string" ||
      !value.session.user?.id || typeof value.session.subscriptionUrl !== "string" || typeof value.selected !== "string" ||
      (value.profileId !== undefined && !profileIds.get().includes(value.profileId))) return null;
    return value;
  } catch { return null; }
}

let accountTrayMenu: ((bounds: Rectangle) => boolean) | null = null;
export function showCustomTrayMenu(bounds: Rectangle): boolean { return accountTrayMenu?.(bounds) ?? false; }

export function registerCustomDesktop(openAdvanced: (route?: string) => void, openCompact: () => void): void {
  let activeProfileId: string | undefined;
  let startedProfileId: string | undefined;
  let proxyOwned = false;
  let snapshot: ProxySnapshot | null = null;
  let proxyServer = "";
  let proxyVerified = false;
  let proxyCheckedAt = 0;
  const recoveryPath = join(app.getPath("userData"), "custom-proxy-recovery.enc");
  const restoreProxy = async () => {
    if (snapshot) {
      const current = await readWindowsProxy();
      // A different proxy belongs to an external change; do not overwrite it.
      if (!proxyServer || current.Server === proxyServer) await writeWindowsProxy(snapshot);
      await unlink(recoveryPath).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
      snapshot = null; proxyServer = ""; proxyVerified = false;
    }
  };
  const requireManaged = () => {
    if (!managedService || daemonState.connection.phase !== "connected") throw new Error("daemon unavailable");
    return managedService;
  };
  let development: DevelopmentAccountOptions = {};
  if (!app.isPackaged) {
    try { development = JSON.parse(readFileSync(join(app.getAppPath(), "bin", "development-account.json"), "utf8")) as DevelopmentAccountOptions; } catch { /* Optional local config. */ }
    if (process.env.KUKUHOU_DEV_LOGIN === "1") development.enabled = true;
    if (process.env.KUKUHOU_DEV_SUBSCRIPTION_URL) development.subscriptionUrl = process.env.KUKUHOU_DEV_SUBSCRIPTION_URL;
  }
  const deviceId = deviceIdentity.get(); deviceIdentity.set(deviceId);
  const configured = configuredAccountApi(app.isPackaged, process.env.KUKUHOU_API_BASE_URL ?? "", development, deviceId);
  const controller = new CompactController(configured.api, {
    load, save,
    loadSelection: (userId) => Object.hasOwn(nodeSelections.get(), userId) ? nodeSelections.get()[userId] : "",
    saveSelection: (userId, selected) => nodeSelections.set({ ...nodeSelections.get(), [userId]: selected }),
    cleanup: async (keep) => {
      for (const id of profileIds.get()) {
        if (id === keep) continue;
        if (profilesState().profiles.some((profile) => profile.id === id)) await callProfileOperation("remove", id);
        profileIds.set(profileIds.get().filter((known) => known !== id));
      }
      activeProfileId = keep;
    },
    read: async (id) => {
      activeProfileId = id;
      const content = await callProfileOperation<string>("readContent", id);
      return (await applicationService.formatConfig({ content })).content;
    },
    sync: async (session, id) => {
      let skipped = 0;
      const trustedOrigin = secureURL(configured.api.baseURL).origin;
      if (!configured.developmentLogin && secureURL(session.subscriptionUrl).origin !== trustedOrigin) throw new AccountError("订阅服务地址不可信");
      const content = await fetchRemoteContent(session.subscriptionUrl, (count) => { skipped = count; }, configured.developmentLogin ? undefined : {
        headers: { Authorization: `Bearer ${session.accessToken}`, "X-Client-Device-Id": deviceId }, origin: trustedOrigin,
        rejected: (status) => new AccountError(status === 401 ? "登录已失效，可能已在其他设备登录，请重新登录" : "订阅暂不可用或账号已停用", status === 401 || status === 403),
      });
      await applicationService.checkConfig({ content });
      const formatted = (await applicationService.formatConfig({ content })).content;
      nodeConfig(formatted);
      if (id && profilesState().profiles.some((profile) => profile.id === id)) {
        // Local managed profile: save without reloading the running service.
        await callProfileOperation("writeContent", id, formatted);
      } else {
        const profile = await callProfileOperation<ProfileMetadata>("create", { name: `${session.user.displayName || "账号"} · 订阅`, type: "local", content: formatted, autoUpdate: false });
        id = profile.id; profileIds.set([...profileIds.get(), id]);
      }
      activeProfileId = id;
      return { id, content: formatted, updated: Date.now(), notice: skipped ? `已跳过 ${skipped} 个不兼容节点，其余节点可正常使用` : "" };
    },
    start: async (content) => {
      const managed = requireManaged();
      if (!activeProfileId) throw new Error("missing account profile");
      await selectProfile(activeProfileId);
      startedProfileId = activeProfileId;
      if (process.platform === "win32") {
        const prepared = systemProxyConfig(content);
        if (!encryptionAvailable()) throw new Error("proxy recovery encryption unavailable");
        snapshot = await readWindowsProxy();
        proxyServer = prepared.server;
        const temporary = `${recoveryPath}.tmp`;
        try { await writeFile(temporary, safeStorage.encryptString(JSON.stringify({ snapshot, server: proxyServer, profileId: startedProfileId })), { mode: 0o600 }); await rename(temporary, recoveryPath); }
        finally { await unlink(temporary).catch(() => {}); }
        await startServiceWithContent(prepared.content);
        await writeWindowsProxy({ Flags: 3, Server: proxyServer, Bypass: "<local>", AutoConfig: "" });
        proxyVerified = true; proxyCheckedAt = Date.now();
        return;
      }
      await startServiceWithContent(content);
      const status = await managed.getSystemProxyStatus({}, { timeoutMs: 5000 });
      if (!status.available) throw new Error("system proxy unavailable");
      // Linux retains the existing platform-managed proxy behavior.
      proxyOwned = true;
      await managed.setSystemProxyEnabled({ enabled: true }, { timeoutMs: 5000 });
      if (!(await managed.getSystemProxyStatus({}, { timeoutMs: 5000 })).enabled) throw new Error("system proxy not enabled");
    },
    stop: async () => {
      let failure: unknown;
      try {
        const managed = requireManaged();
        if (proxyOwned) { await managed.setSystemProxyEnabled({ enabled: false }, { timeoutMs: 5000 }); proxyOwned = false; }
        if (!startedProfileId || profilesState().selectedId === startedProfileId) await managed.stopService({}, { timeoutMs: 5000 });
      } catch (error) { failure = error; }
      // Always restore Windows settings, including when the daemon has disappeared.
      await restoreProxy();
      if (!failure) startedProfileId = undefined;
      if (failure) throw failure;
    },
    select: async (group, tag) => {
      if (!startedService) throw new Error("daemon unavailable");
      await startedService.selectOutbound({ groupTag: group, outboundTag: tag }, { timeoutMs: 5000 });
    },
    running: () => daemonState.status === ServiceStatus_Type.STARTED || daemonState.status === ServiceStatus_Type.STARTING,
    changed: (state) => {
      fitCompactPage(!!state.user);
      for (const window of BrowserWindow.getAllWindows()) if (!window.webContents.isDestroyed()) window.webContents.send(CUSTOM_CHANGED, state);
    },
  });
  controller.state.developmentLogin = configured.developmentLogin;
  let initializationFailed = false;
  const ready = (async () => {
    if (process.platform === "win32" && encryptionAvailable()) {
      try {
        const recovery = JSON.parse(safeStorage.decryptString(await readFile(recoveryPath))) as { snapshot: unknown; server: unknown; profileId: unknown };
        snapshot = parseProxySnapshot(recovery.snapshot);
        if (typeof recovery.server !== "string" || typeof recovery.profileId !== "string" || !profileIds.get().includes(recovery.profileId)) throw new Error("invalid proxy recovery metadata");
        proxyServer = recovery.server; startedProfileId = recovery.profileId;
      }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      await restoreProxy();
      if (startedProfileId && profilesState().selectedId === startedProfileId) {
        // Wait for the normal ownership handshake before stopping a crash-leftover service.
        if (daemonState.connection.phase !== "connected") {
          await new Promise<void>((resolve) => {
            const finish = () => { clearTimeout(timer); daemonState.removeListener("connection", changed); resolve(); };
            const changed = () => { if (daemonState.connection.phase === "connected") finish(); };
            const timer = setTimeout(finish, 10_000);
            daemonState.on("connection", changed);
          });
        }
        if (daemonState.connection.phase === "connected") await requireManaged().stopService({}, { timeoutMs: 5000 });
        startedProfileId = undefined;
      }
    }
    await controller.restore();
  })().catch(() => { initializationFailed = true; controller.state.error = "初始化失败，请检查服务或代理恢复状态后重启"; });
  accountTrayMenu = (bounds) => {
    if (!controller.state.user || !activeProfileId || profilesState().selectedId !== activeProfileId) return false;
    const state = controller.state;
    const disconnect = state.phase === "connected" || state.phase === "failed";
    const action = (operation: () => Promise<void>) => { void operation().catch(() => openCompact()); };
    Menu.buildFromTemplate([
      { label: "打开 Kukuhou", click: openCompact },
      { label: disconnect ? "断开连接" : "连接系统代理", enabled: !state.loading && (disconnect || state.nodes.length > 0), click: () => action(() => disconnect ? controller.disconnect() : controller.connect()) },
      { label: "服务器节点", submenu: state.nodes.map((node) => ({ label: node.tag, type: "radio" as const, checked: state.selected === node.tag, enabled: !state.loading, click: () => action(() => controller.select(node.tag)) })) },
      { label: "更新订阅", enabled: !state.loading, click: () => action(() => controller.refresh()) },
      { label: "高级管理", click: () => openAdvanced() },
      { type: "separator" }, { label: "退出", click: () => app.quit() },
    ]).popup({ x: Math.round(bounds.x), y: Math.round(bounds.y) });
    return true;
  };
  ipcMain.handle(CUSTOM_CALL, async (_event, method: unknown, ...args: unknown[]) => {
    try {
      await ready;
      if (initializationFailed && method !== "state" && method !== "advanced") throw new Error();
      switch (method) {
        case "state": return { ok: true, value: controller.state };
        case "login":
          if (typeof args[0] !== "string" || typeof args[1] !== "string" || typeof args[2] !== "boolean") throw new Error();
          await controller.login(args[0], args[1], args[2]); break;
        case "logout": await controller.logout(); break;
        case "refresh": await controller.refresh(); break;
        case "connect": await controller.connect(); break;
        case "disconnect": await controller.disconnect(); break;
        case "select": if (typeof args[0] !== "string") throw new Error(); await controller.select(args[0]); break;
        case "advanced":
          if (args[0] !== undefined && !["logs", "settings", "profiles"].includes(String(args[0]))) throw new Error();
          openAdvanced(args[0] as string | undefined); break;
        default: throw new Error();
      }
      return { ok: true, value: undefined };
    } catch { return { ok: false, error: controller.state.error || "操作失败，请重试" }; }
  });
  let upload = 0; let download = 0;
  daemonState.on("session", (signal: AbortSignal) => {
    void (async () => {
      try {
        for await (const status of startedService!.subscribeStatus({ interval: 1_000_000_000n }, { signal })) {
          upload = status.trafficAvailable ? Number(status.uplink) : 0;
          download = status.trafficAvailable ? Number(status.downlink) : 0;
        }
      } catch { upload = 0; download = 0; }
    })();
  });
  let polling = false;
  const poll = setInterval(() => {
    if (polling) return; polling = true;
    void (async () => {
      try {
        const running = daemonState.status === ServiceStatus_Type.STARTED;
        if (process.platform === "win32") {
          // Native status reports availability only for tun.platform.http_proxy;
          // the compact mixed listener uses our independent current-user adapter.
          if (running && snapshot && proxyServer && Date.now() - proxyCheckedAt >= 10_000 && !controller.state.loading) {
            const current = await readWindowsProxy();
            proxyVerified = (current.Flags & 2) !== 0 && current.Server === proxyServer;
            proxyCheckedAt = Date.now();
          }
          controller.reconcile(running && (!startedProfileId || profilesState().selectedId === startedProfileId), !!snapshot && proxyVerified, upload, download);
        } else {
          const proxy = running ? await requireManaged().getSystemProxyStatus({}, { timeoutMs: 2000 }) : null;
          controller.reconcile(running, proxy?.enabled ?? false, upload, download);
        }
      } catch { controller.reconcile(false, false); }
      finally { polling = false; }
    })();
  }, 1000);
  const validation = setInterval(() => { if (controller.state.user && !controller.state.loading) void controller.verify().catch(() => {}); }, 60_000);
  const updates = setInterval(() => { if (controller.state.user && !controller.state.loading) void controller.refresh().catch(() => {}); }, 60 * 60 * 1000);
  poll.unref(); updates.unref();
  let exiting = false;
  app.on("before-quit", (event) => {
    if (exiting) return;
    event.preventDefault();
    void controller.shutdown().then(() => { exiting = true; clearInterval(poll); clearInterval(updates); clearInterval(validation); app.quit(); }, () => {
      // Leave the UI available for retry rather than silently abandoning owned proxy state.
      BrowserWindow.getAllWindows().forEach((window) => window.show());
    });
  });
}
