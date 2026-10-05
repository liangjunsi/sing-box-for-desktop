import { AccountApi, AccountError, parseSession } from "./accountApi";
import type { AccountSession } from "./contracts";

export interface DevelopmentAccountOptions {
  enabled?: boolean;
  subscriptionUrl?: string;
}

class DevelopmentAccountApi extends AccountApi {
  constructor(private readonly subscriptionUrl: string) { super("https://development.invalid"); }
  override async login(account: string, password: string): Promise<AccountSession> {
    if (account.trim() !== "dev" || password !== "dev123456") throw new AccountError("开发账号或密码错误");
    return parseSession({ accessToken: `development:${crypto.randomUUID()}`, expiresAt: new Date(Date.now() + 86400_000).toISOString(), user: { id: "development-user", displayName: "开发测试账号" }, subscriptionUrl: this.subscriptionUrl, subscriptionStatus: "active" });
  }
  override async session(session: AccountSession): Promise<AccountSession> {
    if (session.user.id !== "development-user" || !session.accessToken.startsWith("development:") || Date.parse(session.expiresAt) <= Date.now()) throw new AccountError("开发登录已过期，请重新登录", true);
    return parseSession({ ...session, subscriptionUrl: this.subscriptionUrl, subscriptionStatus: "active" });
  }
}

export function configuredAccountApi(packaged: boolean, baseURL: string, options: DevelopmentAccountOptions = {}, deviceId?: string) {
  // Packaged builds never enable the local login, even with copied config or environment flags.
  if (!packaged && options.enabled === true && typeof options.subscriptionUrl === "string" && options.subscriptionUrl) {
    return { api: new DevelopmentAccountApi(options.subscriptionUrl), developmentLogin: { account: "dev", password: "dev123456" } };
  }
  return { api: new AccountApi(baseURL, fetch, deviceId), developmentLogin: undefined };
}
