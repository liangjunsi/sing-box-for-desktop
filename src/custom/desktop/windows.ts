import { app, BrowserWindow, screen, shell } from "electron";
import type { BrowserWindowConstructorOptions } from "electron";
import { join } from "node:path";
import { Preference } from "../../main/database";
import { developmentRendererURL } from "../../main/development";
import { parseMainWindowState, restoredMainWindowBounds } from "../../main/windowState";
import type { MainWindowState } from "../../main/windowState";
import { storedMainWindowState, saveMainWindowState, trayEnabled } from "../../main/settings";
import { APP_NAVIGATE } from "../../shared/ipc";
import { titleBarOverlay } from "../../main/titleBarOverlay";

const compactState = new Preference<MainWindowState | undefined>("custom_compact_window_state", undefined, parseMainWindowState);
let advanced: BrowserWindow | null = null;
let compact: BrowserWindow | null = null;
let compactLoggedIn = false;
let quitting = false;
export function isAdvancedWindow(window: BrowserWindow): boolean { return advanced === window; }
app.on("before-quit", (event) => {
  quitting = true;
  queueMicrotask(() => { if (event.defaultPrevented) quitting = false; });
});

export function compactWindowOptions(): BrowserWindowConstructorOptions {
  const area = screen.getPrimaryDisplay().workArea;
  const state = compactState.get();
  const target = state && screen.getAllDisplays().find((display) => state.x < display.workArea.x + display.workArea.width && state.x + state.width > display.workArea.x && state.y < display.workArea.y + display.workArea.height && state.y + state.height > display.workArea.y)?.workArea || area;
  const width = Math.min(target.width, Math.max(300, state?.width === 360 ? 320 : state?.width ?? 320));
  // Replace the previous default height while preserving manually resized windows.
  const height = Math.min(target.height, 300);
  return {
    x: Math.max(target.x, Math.min(state?.x ?? target.x + Math.round((target.width - width) / 2), target.x + target.width - width)),
    y: Math.max(target.y, Math.min(state?.y ?? target.y + Math.round((target.height - height) / 2), target.y + target.height - height)),
    width, height, useContentSize: true, minWidth: Math.min(300, target.width), minHeight: Math.min(300, target.height),
    minimizable: false, maximizable: false,
    titleBarStyle: "hidden", titleBarOverlay: { color: "#f5f7fb", symbolColor: "#52617a", height: 36 }, backgroundColor: "#f5f7fb", title: "Kukuhou",
  };
}

export function attachCompactWindow(window: BrowserWindow): void {
  compact = window; compactLoggedIn = false;
  window.once("closed", () => { if (compact === window) compact = null; });
  window.setMenu(null);
  const save = () => compactState.set({ ...window.getNormalBounds(), width: window.getContentBounds().width, height: window.getContentBounds().height, maximized: false });
  window.on("moved", save); window.on("resized", save);
  window.on("close", (event) => {
    save();
    if (!quitting && trayEnabled()) { event.preventDefault(); window.hide(); }
  });
}

export function fitCompactPage(loggedIn: boolean): void {
  if (!compact || compact.isDestroyed() || loggedIn === compactLoggedIn) return;
  compactLoggedIn = loggedIn;
  const area = screen.getDisplayMatching(compact.getBounds()).workArea;
  const height = Math.min(area.height, loggedIn ? 380 : 300);
  compact.setMinimumSize(Math.min(300, area.width), height);
  compact.setContentSize(compact.getContentBounds().width, height);
  const bounds = compact.getBounds();
  if (bounds.y + bounds.height > area.y + area.height) compact.setPosition(bounds.x, Math.max(area.y, area.y + area.height - bounds.height));
}

export function openAdvancedWindow(route?: string): BrowserWindow {
  const navigate = (window: BrowserWindow) => { if (route) window.webContents.send(APP_NAVIGATE, route); };
  if (advanced && !advanced.isDestroyed()) {
    if (advanced.isMinimized()) advanced.restore(); advanced.show(); advanced.focus(); navigate(advanced); return advanced;
  }
  const previous = storedMainWindowState();
  const bounds = restoredMainWindowBounds(previous, screen.getAllDisplays().map((display) => display.workArea), screen.getPrimaryDisplay().workArea);
  const window = new BrowserWindow({
    ...bounds, minWidth: Math.min(721, bounds.width), minHeight: Math.min(320, bounds.height), show: false, title: "Kukuhou · 高级管理",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "hidden", titleBarOverlay: titleBarOverlay(),
    trafficLightPosition: process.platform === "darwin" ? { x: 18, y: 19 } : undefined,
    webPreferences: { preload: join(import.meta.dirname, "../preload/index.cjs"), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  advanced = window;
  window.setMenu(null);
  window.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:\/\//.test(url)) void shell.openExternal(url); return { action: "deny" }; });
  window.webContents.on("will-navigate", (event, url) => { if (url !== window.webContents.getURL()) event.preventDefault(); });
  const save = () => { void saveMainWindowState({ ...window.getNormalBounds(), maximized: window.isMaximized() }); };
  window.on("moved", save); window.on("resized", save); window.on("close", save);
  window.once("ready-to-show", () => { if (previous?.maximized) window.maximize(); window.show(); });
  window.once("closed", () => { if (advanced === window) advanced = null; });
  window.webContents.once("did-finish-load", () => { setTimeout(() => { if (!window.isDestroyed()) navigate(window); }, 100); });
  const renderer = developmentRendererURL();
  const loading = renderer ? window.loadURL(renderer) : window.loadFile(join(import.meta.dirname, "../renderer/index.html"));
  void loading.catch(() => { window.destroy(); });
  return window;
}
