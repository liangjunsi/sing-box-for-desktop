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
export interface CompactState {
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
