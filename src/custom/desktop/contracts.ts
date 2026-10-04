export const CUSTOM_CALL = "custom-desktop:call";
export const CUSTOM_CHANGED = "custom-desktop:changed";

export interface AccountSession {
  accessToken: string;
  expiresAt: string;
  user: { id: string; displayName: string };
  subscriptionUrl: string;
}
export interface CompactNode { tag: string; protocol: string }
export interface CompactState {
  developmentLogin?: { account: string; password: string };
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
  login(account: string, password: string, remember: boolean): Promise<void>;
  logout(): Promise<void>;
  refresh(): Promise<void>;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  select(tag: string): Promise<void>;
  advanced(route?: string): Promise<void>;
  onChanged(listener: (state: CompactState) => void): () => void;
}
