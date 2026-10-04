import { ipcRenderer } from "electron";
import type { IpcRendererEvent } from "electron";
import { CUSTOM_CALL, CUSTOM_CHANGED } from "./contracts";
import type { CompactState, CustomBridge } from "./contracts";

async function call<T>(method: string, ...args: unknown[]): Promise<T> {
  const result = await ipcRenderer.invoke(CUSTOM_CALL, method, ...args) as { ok: boolean; value?: T; error?: string };
  if (!result.ok) throw new Error(result.error);
  return result.value as T;
}
export const customBridge: CustomBridge = {
  state: () => call("state"), login: (account, password, remember) => call("login", account, password, remember),
  logout: () => call("logout"), refresh: () => call("refresh"), connect: () => call("connect"), disconnect: () => call("disconnect"),
  select: (tag) => call("select", tag), advanced: (route) => call("advanced", route),
  onChanged: (listener) => {
    const handler = (_event: IpcRendererEvent, state: CompactState) => listener(state);
    ipcRenderer.on(CUSTOM_CHANGED, handler);
    return () => { ipcRenderer.removeListener(CUSTOM_CHANGED, handler); };
  },
};
