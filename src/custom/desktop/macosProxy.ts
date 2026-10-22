import { app } from "electron";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { existsSync } from "node:fs";

const execute = promisify(execFile);
function helper() { return app.isPackaged ? join(process.resourcesPath, "daemon", "macos-proxy") : join(app.getAppPath(), "bin", "darwin", process.arch, "macos-proxy"); }
function journal() { return join(app.getPath("userData"), "macos-proxy-recovery.json"); }
let child: ChildProcess | null = null;
let stopped: Promise<void> | null = null;
let proxyServer = "";
export async function macosProxyEnabled() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return false;
  const parsed = new URL(`http://${proxyServer}`);
  const { stdout } = await execute(helper(), ["status", parsed.hostname.replace(/^\[|\]$/g, ""), parsed.port], { timeout: 5000 });
  return stdout.trim() === "enabled";
}
export async function recoverMacosProxy() {
  if (existsSync(journal())) await execute(helper(), ["recover", journal()], { timeout: 120_000 });
}
export async function enableMacosProxy(server: string) {
  if (child) throw new Error("macOS proxy already active");
  const parsed = new URL(`http://${server}`);
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  const process = spawn(helper(), ["enable", journal(), host, parsed.port], { stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  process.stderr?.on("data", data => { stderr = (stderr + String(data)).slice(-4096); });
  stopped = new Promise<void>((resolve, reject) => {
    process.once("error", reject);
    process.once("exit", code => { if (child === process) child = null; code === 0 ? resolve() : reject(new Error(stderr || "macOS proxy restoration failed")); });
  });
  void stopped.catch(() => {});
  await new Promise<void>((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => { process.stdin?.end(); reject(new Error("macOS proxy authorization timed out")); }, 120_000);
    process.once("error", error => { clearTimeout(timer); reject(error); });
    process.once("exit", () => { clearTimeout(timer); reject(new Error(stderr || "macOS proxy initialization failed")); });
    process.stdout?.on("data", data => { output += String(data); if (output.includes("READY\n")) { clearTimeout(timer); child = process; proxyServer = server; resolve(); } });
  });
}
export async function restoreMacosProxy() {
  if (child) { child.stdin?.end(); await stopped; stopped = null; }
  else await recoverMacosProxy();
}
