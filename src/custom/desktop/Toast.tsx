import { useEffect, useState } from "react";
import "./compact.css";

export function Toast({ notice = "", updated }: { notice?: string; updated?: number }) {
  const [toast, setToast] = useState("");
  useEffect(() => {
    if (notice) setToast(notice);
  }, [notice, updated]);
  useEffect(() => window.desktop.onSubscriptionWarning(setToast), []);
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 4000);
    return () => window.clearTimeout(timer);
  }, [toast, notice, updated]);
  return toast ? <div className="kc-toast" role="status" aria-live="polite"><span>{toast}</span><button aria-label="关闭提示" onClick={() => setToast("")}>×</button></div> : null;
}
