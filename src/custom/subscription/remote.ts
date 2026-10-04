import { BrowserWindow } from "electron";
import { SUBSCRIPTION_WARNING } from "../../shared/ipc";
import { normalizeSubscription } from "./index";

const reportedWarnings = new Map<string, string>();

export async function normalizeRemoteSubscription(content: string, url: string, onSkipped?: (count: number) => void): Promise<string> {
  const result = normalizeSubscription(content, "skip");
  if (onSkipped) {
    onSkipped(result.skipped.length);
    return result.content;
  }
  const warning = result.skipped.join("\n");
  if (warning && reportedWarnings.get(url) !== warning) {
    const message = `已跳过 ${result.skipped.length} 个无法安全转换的节点，其余节点可正常使用（保留 TLS 安全校验）`;
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.webContents.isDestroyed()) window.webContents.send(SUBSCRIPTION_WARNING, message);
    }
    reportedWarnings.set(url, warning);
  } else if (!warning) {
    reportedWarnings.delete(url);
  }
  return result.content;
}
