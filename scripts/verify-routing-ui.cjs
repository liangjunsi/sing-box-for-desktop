// Synthetic UI harness: no accounts, daemon or system proxy changes.
const { app, BrowserWindow, ipcMain } = require("electron");
const { mkdirSync, writeFileSync } = require("node:fs");
const { resolve } = require("node:path");
const output = resolve("bin/routing-ui-verify");
let settingsWindow;
async function openSettings() {
  if (settingsWindow && !settingsWindow.isDestroyed()) return;
  settingsWindow = new BrowserWindow({ width: 520, height: 720, show: false, webPreferences: { preload: resolve("out/preload/index.cjs"), sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  settingsWindow.setMenu(null);
  await settingsWindow.loadFile(resolve("out/renderer/index.html"), { query: { routingSettings: "1" } });
}
app.setPath("userData", resolve(output, "user-data"));
let state = { routing: { mode: "smart", rules: [], version: 1 }, activeRoutingMode: "smart", activeRoutingVersion: 1, configured: true, user: { id: "test", displayName: "测试账号" }, nodes: [{ tag: "测试节点", protocol: "socks" }], selected: "测试节点", phase: "connected", loading: false, error: "", notice: "", upload: 0, download: 0 };
ipcMain.on("preferences:snapshot", event => { event.returnValue = {}; });
ipcMain.handle("settings:call", () => ({ ok: true, value: { openAtLogin: false } }));
ipcMain.handle("app:call", () => ({ ok: true }));
ipcMain.handle("custom-desktop:call", async (event, method, value) => {
  if (method === "openRoutingSettings") await openSettings();
  if (method === "resize") BrowserWindow.fromWebContents(event.sender).setContentSize(320, Math.max(338, value));
  if (method === "setRoutingMode") { state.routing.mode = value; state.routing.version++; state.routingPending = value !== state.activeRoutingMode; }
  if (method === "saveRoutingRule") { const index = state.routing.rules.findIndex(r => r.id === value.id); if (index < 0) state.routing.rules.push(value); else state.routing.rules[index] = value; state.routing.version++; state.routingPending = true; }
  if (method === "deleteRoutingRule") { state.routing.rules = state.routing.rules.filter(r => r.id !== value); state.routing.version++; }
  for (const target of BrowserWindow.getAllWindows()) target.webContents.send("custom-desktop:changed", state);
  return { ok: true, value: method === "state" ? state : undefined };
});
app.whenReady().then(async () => {
  mkdirSync(output, { recursive: true });
  let window = new BrowserWindow({ width: 320, height: 420, show: false, webPreferences: { preload: resolve("out/preload/index.cjs"), sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  const mainWindow = window;
  window.setMenu(null);
  const errors = []; window.webContents.on("console-message", event => { if (event.level === "error") errors.push(event.message); });
  const timer = setTimeout(() => app.exit(1), 20000);
  const pause = () => new Promise(done => setTimeout(done, 150));
  const js = code => window.webContents.executeJavaScript(code);
  const check = async (code, message) => { if (!await js(code)) throw new Error(message); };
  const capture = async name => { await pause(); writeFileSync(resolve(output, `${name}.png`), (await window.webContents.capturePage(undefined, { stayHidden: true })).toPNG()); };
  await window.loadFile(resolve("out/renderer/index.html"), { query: { compact: "1" } }); await pause();
  await js("document.querySelector('.kc-menu-toggle').click()"); await pause();
  await check("!document.querySelector('[name=routing-mode]')", "routing controls should be in dialog only");
  await js("Array.from(document.querySelectorAll('.kc-menu button')).find(b => b.textContent === '路由设置').click()"); await pause();
  if (!settingsWindow || settingsWindow === mainWindow || settingsWindow.getParentWindow()) throw new Error("independent settings window missing");
  window = settingsWindow;
  await check("document.querySelector('.kc-routing-window') && !document.querySelector('#kc-rules-title') && !document.querySelector('[aria-label=关闭路由设置]')", "routing settings window contains duplicate heading or close button");
  window.setBounds({ x: mainWindow.getBounds().x + mainWindow.getBounds().width + 20, y: mainWindow.getBounds().y, width: 560, height: 720 });
  await openSettings(); if (BrowserWindow.getAllWindows().length !== 2) throw new Error("duplicate settings window");
  await check("document.querySelectorAll('[name=routing-mode]').length === 2", "mode choices missing");
  await js("document.querySelectorAll('[name=routing-mode]')[1].click()"); await pause();
  await check("document.querySelectorAll('[name=routing-mode]')[1].checked", "saved mode radio not selected");
  await check("document.body.innerText.includes('下次连接生效')", "pending mode missing");
  if (!await mainWindow.webContents.executeJavaScript("document.querySelector('.kc-status').textContent.includes('智能分流') && document.body.innerText.includes('下次连接生效')")) throw new Error("main window state not synchronized");
  await capture("menu");
  await check("!!document.querySelector('.kc-rules')", "rules panel missing");
  await js("document.querySelector('.kc-rules .kc-primary').click()"); await pause();
  await js("(() => { const input = document.querySelector('.kc-rules input[required]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'example.com'); input.dispatchEvent(new Event('input', {bubbles:true})); })()"); await pause();
  await capture("editor");
  await js("document.querySelector('.kc-rules form').requestSubmit()"); await pause();
  await check("!document.querySelector('.kc-rules form') && document.querySelector('.kc-rule-list').textContent.includes('example.com')", "save did not close editor or show rule");
  await js("Array.from(document.querySelectorAll('.kc-rule-list button')).find(b => b.textContent === '编辑').click()"); await pause();
  await check("document.querySelector('.kc-rules input[required]').value === 'example.com'", "edit did not load rule");
  await js("Array.from(document.querySelectorAll('.kc-rules form button')).find(b => b.textContent === '取消').click()"); await pause();
  await capture("rules");
  await js("Array.from(document.querySelectorAll('.kc-rule-list button')).find(b => b.textContent === '删除').click()"); await pause();
  await check("document.querySelector('.kc-rule-list').textContent.includes('删除这条规则？')", "inline confirmation missing");
  await js("Array.from(document.querySelectorAll('.kc-rule-list button')).find(b => b.textContent === '确认删除').click()"); await pause();
  await check("document.querySelector('.kc-rules').textContent.includes('暂无自定义规则')", "delete failed");
  await check("document.documentElement.scrollWidth <= innerWidth", "window layout overflow");
  window.close(); await pause();
  if (!window.isDestroyed() || mainWindow.isDestroyed()) throw new Error("closing settings affected main window");
  await openSettings(); await pause();
  if (!await settingsWindow.webContents.executeJavaScript("document.querySelectorAll('[name=routing-mode]')[1].checked")) throw new Error("reopened settings lost saved mode");
  settingsWindow.destroy();
  if (errors.length) throw new Error(errors.join("\n"));
  clearTimeout(timer); console.log("routing UI: mode selection, pending state, add, edit, delete and layout passed");
  mainWindow.destroy(); app.quit();
}).catch(error => { console.error(error); app.exit(1); });
