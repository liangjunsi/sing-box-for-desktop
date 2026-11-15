import { useEffect, useState } from "react";
import type { CompactState } from "./contracts";
import { RoutingRules } from "./RoutingRules";
import "./compact.css";

export function RoutingSettingsApp() {
  const bridge = window.desktop.custom;
  const [state, setState] = useState<CompactState | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let disposed = false;
    const off = bridge.onChanged(value => { if (!disposed) setState(value); });
    void bridge.state().then(value => { if (!disposed) setState(value); }).catch(() => { if (!disposed) setError("路由设置加载失败，请关闭窗口后重试"); });
    return () => { disposed = true; off(); };
  }, [bridge]);
  return <main className="kukuhou-compact kc-routing-page">
    {error ? <p role="alert">{error}</p> : !state ? <p role="status">正在加载路由设置…</p> : <RoutingRules rules={state.routing.rules} mode={state.routing.mode} routingPending={state.routingPending} bridge={bridge} busy={state.loading} />}
  </main>;
}
