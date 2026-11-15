export const CUSTOM_CALL = "custom-desktop:call";
export const CUSTOM_CHANGED = "custom-desktop:changed";

export interface AccountPlan {
  subscriptionStatus?: "active" | "pending" | "expired" | "quota_exhausted";
  usedBytes?: number;
  quotaBytes?: number;
  usageMonth?: string;
  subscriptionExpiresAt?: string | null;
}
export interface AccountSession extends AccountPlan {
  accessToken: string;
  expiresAt: string;
  user: { id: string; displayName: string };
  subscriptionUrl: string | null;
}
export interface CompactNode { tag: string; protocol: string }
export type RoutingMode = "smart" | "global";
export interface CustomRoutingRule {
  id: string;
  type: "domain" | "ip";
  target: string;
  scope: "suffix" | "exact";
  action: "direct" | "proxy";
}
export interface RoutingSettings { mode: RoutingMode; rules: CustomRoutingRule[]; version: number }
export interface CompactState {
  routing: RoutingSettings;
  activeRoutingMode?: RoutingMode;
  activeRoutingVersion?: number;
  routingPending?: boolean;
  developmentLogin?: { account: string; password: string };
  plan?: AccountPlan;
  planCached?: boolean;
  configured: boolean;
  user: AccountSession["user"] | null;
  nodes: CompactNode[];
  selected: string;
  phase: "idle" | "connecting" | "connected" | "disconnecting" | "failed";
  loading: boolean;
  error: string;
  notice: string;
  lastUpdated?: number;
  upload: number;
  download: number;
}
export interface CustomBridge {
  openRoutingSettings(): Promise<void>;
  setRoutingMode(mode: RoutingMode): Promise<void>;
  saveRoutingRule(rule: CustomRoutingRule): Promise<void>;
  deleteRoutingRule(id: string): Promise<void>;
  state(): Promise<CompactState>;
  resize(height: number): Promise<void>;
  login(account: string, password: string, remember: boolean): Promise<void>;
  logout(): Promise<void>;
  refresh(): Promise<void>;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  select(tag: string): Promise<void>;
  advanced(route?: string): Promise<void>;
  licenses(): Promise<void>;
  onChanged(listener: (state: CompactState) => void): () => void;
}
