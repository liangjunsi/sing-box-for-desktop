import { useState } from "react";
import type { CustomBridge, CustomRoutingRule, RoutingMode } from "./contracts";

export function RoutingRules({ rules, mode, routingPending, bridge, busy }: { rules: CustomRoutingRule[]; mode: RoutingMode; routingPending?: boolean; bridge: CustomBridge; busy: boolean }) {
  const [draft, setDraft] = useState<CustomRoutingRule | null>(null);
  const [search, setSearch] = useState("");
  const [deleting, setDeleting] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const disabled = busy || pending;
  async function run(action: () => Promise<void>) {
    setPending(true); setError("");
    try { await action(); setDraft(null); setDeleting(""); }
    catch (e) { setError(e instanceof Error ? e.message : "保存失败，请重试"); }
    finally { setPending(false); }
  }
  return <section className="kc-rules kc-routing-window" aria-label="路由设置">
    {!draft && <fieldset className="kc-routing-modes" disabled={disabled}><legend>路由模式</legend>
      {(["smart", "global"] as const).map(value => <label key={value}><input type="radio" name="routing-mode" checked={mode === value} onChange={() => void run(() => bridge.setRoutingMode(value))} />{value === "smart" ? "智能分流" : "全局代理"}<small>{value === "smart" ? "国内网站和局域网默认直连，其他走 VPN" : "公网流量默认走 VPN"}；自定义规则优先</small></label>)}
    </fieldset>}
    {routingPending && <p role="status">路由设置已修改，下次连接生效。</p>}
    <p>自定义规则优先于默认分流，本地和局域网始终直连。修改将在下次连接生效。</p>
    {error && <div role="alert" className="kc-message kc-error">{error}</div>}
    {draft ? <form onSubmit={event => { event.preventDefault(); void run(() => bridge.saveRoutingRule(draft)); }}>
      <fieldset disabled={disabled}>
        <legend>{rules.some(r => r.id === draft.id) ? "编辑规则" : "新增规则"}</legend>
        <label>类型<select value={draft.type} onChange={e => setDraft({ ...draft, type: e.target.value as "domain" | "ip" })}><option value="domain">域名</option><option value="ip">IP / 网段</option></select></label>
        <label>目标<input autoFocus required maxLength={253} value={draft.target} placeholder={draft.type === "domain" ? "example.com" : "1.2.3.4 或 192.0.2.0/24"} onChange={e => setDraft({ ...draft, target: e.target.value })} /></label>
        {draft.type === "domain" && <label>域名范围<select value={draft.scope} onChange={e => setDraft({ ...draft, scope: e.target.value as "suffix" | "exact" })}><option value="suffix">包含子域名</option><option value="exact">仅此域名</option></select></label>}
        <label>路由方式<select value={draft.action} onChange={e => setDraft({ ...draft, action: e.target.value as "direct" | "proxy" })}><option value="direct">直连</option><option value="proxy">走 VPN</option></select></label>
        <p>不支持协议、端口、路径、通配符和正则表达式。</p>
        <div className="kc-rule-actions"><button className="kc-primary" type="submit">保存</button><button type="button" onClick={() => { setDraft(null); setError(""); }}>取消</button></div>
      </fieldset>
    </form> : <>
      <h3>自定义规则（{rules.length}）</h3>
      <button className="kc-primary" disabled={disabled} onClick={() => { setError(""); setDraft({ id: crypto.randomUUID(), type: "domain", target: "", scope: "suffix", action: "direct" }); }}>新增规则</button>
      <input aria-label="搜索规则目标" placeholder="搜索域名或 IP" value={search} onChange={e => setSearch(e.target.value)} />
      <ul className="kc-rule-list">
        {rules.filter(r => r.target.toLowerCase().includes(search.trim().toLowerCase())).map(r => <li key={r.id}>
          <strong>{r.target}</strong><span>{r.type === "domain" ? r.scope === "exact" ? "仅此域名" : "包含子域名" : "IP / 网段"} · {r.action === "direct" ? "直连" : "走 VPN"}</span>
          {deleting === r.id ? <div role="group" aria-label="确认删除规则"><p>删除这条规则？</p><button disabled={disabled} onClick={() => void run(() => bridge.deleteRoutingRule(r.id))}>确认删除</button><button disabled={disabled} onClick={() => setDeleting("")}>取消</button></div> : <div className="kc-rule-actions"><button disabled={disabled} onClick={() => { setError(""); setDraft({ ...r }); }}>编辑</button><button disabled={disabled} onClick={() => setDeleting(r.id)}>删除</button></div>}
        </li>)}
      </ul>
      {!rules.length && <p>暂无自定义规则。</p>}
      {!!rules.length && !rules.some(r => r.target.toLowerCase().includes(search.trim().toLowerCase())) && <p>没有匹配的规则。</p>}
    </>}
    <small>仅对使用系统代理的流量生效。</small>
  </section>;
}
