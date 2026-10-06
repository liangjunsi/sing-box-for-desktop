import { useEffect, useState, useRef } from "react";
import type { FormEvent } from "react";
import type { CompactState } from "./contracts";
import { NodePicker } from "./NodePicker";
import { Toast } from "./Toast";
import { LegalNotice } from "./LegalNotice";
import "./compact.css";

const initial: CompactState = { configured: false, user: null, nodes: [], selected: "", phase: "idle", loading: true, error: "", notice: "", upload: 0, download: 0 };
function rate(value: number) {
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB/s`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KB/s`;
  return `${Math.max(0, Math.round(value))} B/s`;
}
export function CompactApp() {
  const [state, setState] = useState(initial);
  const [account, setAccount] = useState(""); const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(true);
  const [menu, setMenu] = useState(false); const [pending, setPending] = useState(false);
  const [legal, setLegal] = useState(false);
  const [error, setError] = useState(""); const [openAtLogin, setOpenAtLogin] = useState(false);
  const custom = window.desktop.custom;
  const developmentFilled = useRef(false);
  useEffect(() => {
    if (state.user) { developmentFilled.current = false; return; }
    if (state.developmentLogin && !developmentFilled.current) {
      developmentFilled.current = true;
      setAccount(state.developmentLogin.account); setPassword(state.developmentLogin.password); setRemember(false);
    }
  }, [state.developmentLogin, state.user]);
  useEffect(() => {
    let disposed = false;
    const unsubscribe = custom.onChanged((value) => { if (!disposed) setState(value); });
    void custom.state().then((value) => { if (!disposed) setState(value); }).catch(() => { if (!disposed) setError("客户端初始化失败，请重启或打开高级管理"); });
    void window.desktop.settings.get().then((value) => { if (!disposed) setOpenAtLogin(value.openAtLogin); }).catch(() => {});
    return () => { disposed = true; unsubscribe(); };
  }, [custom]);
  const busy = state.loading || pending;
  async function run(action: () => Promise<unknown>) {
    if (pending) return;
    setPending(true); setError("");
    try { await action(); } catch (failure) { setError(failure instanceof Error ? failure.message : "操作失败，请重试"); }
    finally { setPending(false); }
  }
  function login(event: FormEvent) {
    event.preventDefault();
    const secret = password; setPassword("");
    void run(() => custom.login(account, secret, remember));
  }
  const connected = state.phase === "connected";
  const labels = { idle: "未连接", connecting: "正在连接…", connected: "已连接 · 系统代理", disconnecting: "正在断开…", failed: "连接异常" };
  const node = state.nodes.find((item) => item.tag === state.selected);
  return <main className="kukuhou-compact">
    <header className="kc-header">
      <button className="kc-menu-toggle" aria-label="设置菜单" aria-expanded={menu} onClick={() => setMenu(!menu)}>☰</button>
      {menu && <><button className="kc-dismiss" aria-label="关闭菜单" onClick={() => setMenu(false)} />
        <div className="kc-menu">
          {state.user && <button disabled={busy} onClick={() => { setMenu(false); void run(() => custom.refresh()); }}>更新订阅</button>}
          <button disabled={pending} onClick={() => { void run(async () => { await window.desktop.settings.setOpenAtLogin(!openAtLogin); setOpenAtLogin(!openAtLogin); }); }}>开机启动 {openAtLogin ? "✓" : ""}</button>
          <button onClick={() => { setMenu(false); void run(() => custom.advanced("logs")); }}>查看日志</button>
          <button onClick={() => { setMenu(false); void run(() => custom.advanced()); }}>高级管理</button>
          <button onClick={() => { setMenu(false); setLegal(true); }}>关于与开源许可</button>
          {state.user && <button disabled={busy} onClick={() => { setMenu(false); void run(() => custom.logout()); }}>退出登录</button>}
          <button onClick={() => { void run(() => window.desktop.app.quit()); }}>退出程序</button>
        </div></>}
    </header>
    {(error || state.error) && <div className="kc-message kc-error" role="alert">{error || state.error}</div>}
    <Toast notice={state.notice} updated={state.lastUpdated} />
    {!state.user ? <form className="kc-login" onSubmit={login}>
      <label>账号<input autoComplete="username" value={account} maxLength={512} onChange={(event) => setAccount(event.target.value)} placeholder="请输入账号" required disabled={busy} /></label>
      <label>密码<input type="password" autoComplete="current-password" value={password} maxLength={4096} onChange={(event) => setPassword(event.target.value)} placeholder="请输入密码" required disabled={busy} /></label>
      <label className="kc-remember"><input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} disabled={busy} />记住登录</label>
      <button className="kc-primary" disabled={busy || !state.configured}>{busy ? "正在加载…" : "登录"}</button>
      {!state.configured && !busy && <p className="kc-message">尚未配置登录服务。可通过菜单打开高级管理，使用现有配置。</p>}
    </form> : <section className="kc-connection">
      <div className="kc-account" title={state.user.displayName}>{state.user.displayName || "我的账号"}</div>
      <button className={`kc-power ${connected ? "kc-on" : ""}`} disabled={busy || (!connected && state.phase !== "failed" && !state.nodes.length)} aria-label={connected || state.phase === "failed" ? "断开连接" : "连接系统代理"} onClick={() => void run(() => connected || state.phase === "failed" ? custom.disconnect() : custom.connect())}>
        <span className="kc-power-icon">⏻</span><strong>{connected ? "ON" : "OFF"}</strong>
      </button>
      <p className="kc-status" role="status">{labels[state.phase]}</p>
      <div className="kc-node"><label htmlFor="kc-search">服务器节点 <span>{node?.protocol.toUpperCase() ?? "—"}</span></label>
        <NodePicker nodes={state.nodes} selected={state.selected} disabled={busy} onSelect={(tag) => run(() => custom.select(tag))} />
      </div>
      <div className="kc-traffic"><div><span>↓ 下载</span><strong>{rate(state.download)}</strong></div><div><span>↑ 上传</span><strong>{rate(state.upload)}</strong></div></div>
      <footer>{state.lastUpdated ? `更新于 ${new Date(state.lastUpdated).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}` : "等待加载订阅"}<button disabled={busy} onClick={() => void run(() => custom.refresh())}>刷新</button></footer>
    </section>}
    {legal && <LegalNotice onClose={() => setLegal(false)} />}
  </main>;
}
