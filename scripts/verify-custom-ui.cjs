// Development-only UI verification. Synthetic bridge responses never ship in the app.
const { app, BrowserWindow, ipcMain } = require("electron");
const { mkdirSync, writeFileSync, unlinkSync } = require("node:fs");
const { resolve } = require("node:path");
const scale = process.argv[2] || "1";
app.commandLine.appendSwitch("force-device-scale-factor", scale);
const output = resolve("bin/custom-ui-verify");
app.setPath("userData", resolve(output, `user-data-${scale}`));
let state = { configured: true, user: null, nodes: [], selected: "", phase: "idle", loading: false, error: "", notice: "", upload: 0, download: 0 };
ipcMain.on("preferences:snapshot", (event) => { event.returnValue = {}; });
ipcMain.handle("settings:call", () => ({ ok: true, value: { openAtLogin: false } }));
ipcMain.handle("app:call", () => ({ ok: true, value: "test" }));
ipcMain.handle("custom-desktop:call", (_event, method) => ({ ok: true, value: method === "state" ? state : undefined }));
app.whenReady().then(async () => {
  const deadline = setTimeout(() => { writeFileSync(resolve(output, `failure-${scale}.txt`), "UI verification timed out"); app.exit(1); }, 25_000);
  mkdirSync(output, { recursive: true });
  const window = new BrowserWindow({ width: 360, height: 440, useContentSize: true, show: false, webPreferences: { preload: resolve("out/preload/index.cjs"), contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  window.setMenu(null);
  const failures = [];
  const reports = [];
  window.webContents.on("console-message", (event) => { if (event.level === "error") failures.push(event.message); });
  await window.loadFile(resolve("out/renderer/index.html"), { query: { compact: "1" } });
  const pause = () => new Promise((done) => setTimeout(done, 300));
  async function capture(name) {
    await pause();
    const metrics = await window.webContents.executeJavaScript(`(() => {
      const root = document.querySelector('.kukuhou-compact');
      return { width: innerWidth, height: innerHeight, scrollWidth: Math.max(document.documentElement.scrollWidth,document.body.scrollWidth), scrollHeight: Math.max(document.documentElement.scrollHeight,document.body.scrollHeight), buttons: root?.querySelectorAll('button').length, text: root?.innerText };
    })()`);
    if (!metrics.buttons || metrics.scrollWidth > metrics.width) throw new Error(`UI layout failed: ${JSON.stringify(metrics)}`);
    if (name !== "error" && metrics.scrollHeight > metrics.height) throw new Error(`Normal UI requires scrolling: ${name}`);
    reports.push({ name, scale, ...metrics, bounds: window.getBounds(), contentBounds: window.getContentBounds() });
    writeFileSync(resolve(output, `report-${scale}.json`), JSON.stringify(reports, null, 2));
    writeFileSync(resolve(output, `${name}-${scale}.png`), (await window.webContents.capturePage(undefined, { stayHidden: true })).toPNG());
    console.log(JSON.stringify({ name, scale, width: metrics.width, height: metrics.height, scrollHeight: metrics.scrollHeight }));
  }
  await capture("login");
  const warning = "已跳过 1 个无法安全转换的节点，其余节点可正常使用（保留 TLS 安全校验）";
  window.webContents.send("subscription:warning", warning);
  await capture("subscription-warning");
  if (await window.webContents.executeJavaScript("document.querySelector('.kc-toast')?.textContent") !== `${warning}×`) throw new Error("Subscription warning toast missing");
  await window.webContents.executeJavaScript("document.querySelector('.kc-toast button').click(); true");
  await pause();
  if (await window.webContents.executeJavaScript("!!document.querySelector('.kc-toast')")) throw new Error("Toast dismissal failed");
  state = { ...state, user: { id: "synthetic", displayName: "测试账号" }, nodes: [{ tag: "香港 01 · 稳定线路", protocol: "vless" }, { tag: "新加坡 02", protocol: "hysteria2" }], selected: "香港 01 · 稳定线路", lastUpdated: Date.now() };
  window.webContents.send("custom-desktop:changed", state); await capture("disconnected");
  state = { ...state, phase: "connected", upload: 23456, download: 1234567 };
  window.webContents.send("custom-desktop:changed", state); await capture("connected");
  await window.webContents.executeJavaScript("setTimeout(() => document.querySelector('.kc-menu-toggle').click(), 0); true"); await capture("menu");
  await window.webContents.executeJavaScript("setTimeout(() => document.querySelector('.kc-dismiss').click(), 0); true");
  state = { ...state, phase: "failed", error: "连接失败，请检查守护进程与系统代理权限", notice: "订阅已更新，下次连接生效" };
  window.webContents.send("custom-desktop:changed", state); await capture("error");
  if (failures.length) throw new Error(failures.join("\n"));
  writeFileSync(resolve(output, `passed-${scale}.json`), JSON.stringify({ passed: true, scale, captures: reports.length }));
  try { unlinkSync(resolve(output, `failure-${scale}.txt`)); } catch (error) { if (error.code !== "ENOENT") throw error; }
  clearTimeout(deadline);
  window.destroy(); app.quit();
}).catch((error) => { mkdirSync(output, { recursive: true }); writeFileSync(resolve(output, `failure-${scale}.txt`), String(error)); console.error(error); app.exit(1); });
