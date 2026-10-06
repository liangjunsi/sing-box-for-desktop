import type { AccountSession } from "./contracts";

export class AccountError extends Error {
  constructor(message: string, readonly invalidSession = false) { super(message); }
}

export function secureURL(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password) throw new AccountError("服务地址必须使用 HTTPS");
  return url;
}

export function trustedSubscriptionOrigin(baseURL: string, subscriptionURL: string, configuredOrigin = ""): string {
  const target = secureURL(subscriptionURL).origin;
  const allowed = [secureURL(baseURL).origin];
  if (configuredOrigin) allowed.push(secureURL(configuredOrigin).origin);
  if (!allowed.includes(target)) throw new AccountError("订阅域名未配置为可信服务，请检查 KUKUHOU_SUBSCRIPTION_ORIGIN");
  return target;
}

export function parseSession(value: unknown, token?: string): AccountSession {
  if (!value || typeof value !== "object") throw new AccountError("登录服务返回格式错误");
  const data = value as Partial<AccountSession>;
  const accessToken = token ?? data.accessToken;
  if (typeof accessToken !== "string" || !accessToken || typeof data.expiresAt !== "string" ||
    !Number.isFinite(Date.parse(data.expiresAt)) || Date.parse(data.expiresAt) <= Date.now() ||
    typeof data.user?.id !== "string" || !data.user.id || typeof data.user.displayName !== "string" ||
    typeof data.subscriptionUrl !== "string") throw new AccountError("登录服务返回格式错误");
  try { secureURL(data.subscriptionUrl); } catch { throw new AccountError("订阅地址无效"); }
  if (!["active", "pending", "expired", "quota_exhausted"].includes(data.subscriptionStatus ?? "")) throw new AccountError("订阅状态格式错误");
  return { subscriptionStatus: data.subscriptionStatus, accessToken, expiresAt: data.expiresAt, user: { id: data.user.id, displayName: data.user.displayName }, subscriptionUrl: data.subscriptionUrl };
}

export class AccountApi {
  constructor(readonly baseURL: string, private readonly request: typeof fetch = fetch, readonly deviceId: string = crypto.randomUUID()) {}
  private async call(path: string, init: RequestInit): Promise<unknown> {
    if (!this.baseURL) throw new AccountError("尚未配置登录服务，请联系管理员");
    const url = secureURL(this.baseURL);
    url.pathname = `${url.pathname.replace(/\/$/, "")}/api/client/${path}`;
    url.search = ""; url.hash = "";
    let response: Response;
    try { response = await this.request(url, { ...init, redirect: "error", signal: AbortSignal.timeout(15_000) }); }
    catch { throw new AccountError("登录服务暂时无法访问，请稍后重试"); }
    if (!response.ok) {
      const messages: Record<number, string> = { 401: path === "login" ? "登录接口拒绝认证（401），请核对客户端账号及服务端账号绑定" : "会话接口拒绝认证（401），请重新登录", 403: "账号已停用", 429: "请求过于频繁，请稍后重试" };
      throw new AccountError(messages[response.status] ?? "登录服务请求失败", response.status === 401 || response.status === 403);
    }
    // Never surface response bodies: they may contain credentials.
    try {
      const reader = response.body?.getReader();
      if (!reader) throw new Error();
      let size = 0; const chunks: Uint8Array[] = [];
      for (;;) {
        const result = await reader.read(); if (result.done) break;
        size += result.value.byteLength;
        if (size > 64 * 1024) { await reader.cancel(); throw new Error(); }
        chunks.push(result.value);
      }
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      return JSON.parse(new TextDecoder().decode(bytes));
    } catch { throw new AccountError("登录服务返回格式错误"); }
  }
  async login(account: string, password: string): Promise<AccountSession> {
    if (!account.trim() || !password || account.length > 512 || password.length > 4096) throw new AccountError("请输入有效账号和密码");
    return parseSession(await this.call("login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ account: account.trim(), password, deviceId: this.deviceId }) }));
  }
  async logout(session: AccountSession): Promise<void> {
    await this.call("logout", { method: "POST", headers: { Authorization: `Bearer ${session.accessToken}`, "X-Client-Device-Id": this.deviceId } });
  }
  async session(session: AccountSession): Promise<AccountSession> {
    if (Date.parse(session.expiresAt) <= Date.now()) throw new AccountError("登录已过期，请重新登录", true);
    const result = parseSession(await this.call("session", { headers: { Authorization: `Bearer ${session.accessToken}`, "X-Client-Device-Id": this.deviceId } }), session.accessToken);
    if (result.user.id !== session.user.id) throw new AccountError("账号会话不一致，请重新登录", true);
    return result;
  }
}
