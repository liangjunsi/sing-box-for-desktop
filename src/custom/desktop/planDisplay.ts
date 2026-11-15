import type { AccountPlan } from "./contracts";
export function planDisplay(plan?: AccountPlan, now = Date.now()) {
  const used = plan?.usedBytes, quota = plan?.quotaBytes;
  const valid = typeof used === "number" && Number.isFinite(used) && used >= 0 && typeof quota === "number" && Number.isFinite(quota) && quota >= 0;
  const unit = valid ? Math.min(4, Math.max(0, Math.floor(Math.log(Math.max(used, quota, 1)) / Math.log(1024)))) : 0;
  const divisor = 1024 ** unit;
  const usage = valid ? `${(used / divisor).toFixed(unit ? 1 : 0)} / ${(quota / divisor).toFixed(unit ? 1 : 0)} ${["B", "KiB", "MiB", "GiB", "TiB"][unit]}` : "暂无数据";
  const usagePercent = valid ? quota === 0 ? 100 : Math.min(100, Math.floor((used / quota) * 1000) / 10) : undefined;
  const exhausted = plan?.subscriptionStatus === "quota_exhausted" || (valid && used >= quota);
  const expiry = plan?.subscriptionExpiresAt;
  const timestamp = typeof expiry === "string" ? Date.parse(expiry) : NaN;
  const expired = plan?.subscriptionStatus === "expired" || (Number.isFinite(timestamp) && timestamp <= now);
  const date = new Date(timestamp);
  return {
    usagePercent,
    usage,
    usageTitle: valid ? `统计月份：${plan?.usageMonth ?? "未知"}；已用 ${usage}` : "暂无数据",
    usageStatus: exhausted ? "额度耗尽" : valid && used >= quota * .9 ? "即将用尽" : "",
    usageTone: exhausted ? "danger" : valid && used >= quota * .9 ? "warning" : "",
    expiry: expiry === null ? "长期有效" : Number.isFinite(timestamp) ? `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}` : "暂无数据",
    expiryTitle: Number.isFinite(timestamp) ? date.toLocaleString() : expiry === null ? "无到期限制" : "暂无数据",
    expiryStatus: expired ? "已到期" : timestamp - now < 7 * 86400_000 ? "即将到期" : "",
    expiryTone: expired ? "danger" : timestamp - now < 7 * 86400_000 ? "warning" : "",
  };
}
