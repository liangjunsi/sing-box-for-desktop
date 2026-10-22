import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import ts from "typescript";

// Exercise the native development executable, not just its icon resources.
if (process.platform === "win32") {
  const root = resolve(import.meta.dirname, "..");
  const output = join(root, "bin", "windows-development-verify");
  mkdirSync(output, { recursive: true });
  // Resource editing allocates large PE buffers. Release that process before
  // launching Chromium so the verification also works on low-memory machines.
  const preparation = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e",
    `import { prepareWindowsDevelopmentRuntime } from './scripts/windowsDevelopment.ts';
     prepareWindowsDevelopmentRuntime(process.cwd());
     console.log(process.env.ELECTRON_EXEC_PATH);`,
  ], { cwd: root, encoding: "utf8", timeout: 60_000 });
  assert.equal(preparation.status, 0, preparation.stderr);
  const executable = preparation.stdout.trim();
  assert.ok(executable.endsWith("electron.exe"), executable);

  const resourceModule = join(output, "resources.cjs");
  writeFileSync(resourceModule, ts.transpileModule(readFileSync(join(root, "src/main/resources.ts"), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText);
  const probe = join(output, "probe.cjs");
  const report = join(output, "passed.json");
  writeFileSync(probe, `
    const assert = require('node:assert/strict');
    const { writeFileSync } = require('node:fs');
    const { join } = require('node:path');
    const { app, BrowserWindow, nativeImage } = require('electron');
    assert.equal(app.isPackaged, false, 'Development runtime must remain unpackaged');
    app.setAppPath(${JSON.stringify(root)});
    app.setPath('userData', ${JSON.stringify(join(output, "user-data"))});
    app.whenReady().then(() => {
      const { windowIconPath } = require(${JSON.stringify(resourceModule)});
      const icon = windowIconPath();
      assert.equal(icon, join(${JSON.stringify(root)}, 'resources', 'icon.ico'));
      assert.equal(nativeImage.createFromPath(icon).isEmpty(), false);
      const window = new BrowserWindow({ show: false, icon });
      window.setIcon(icon);
      window.setAppDetails({ appId: 'com.kukuhou.desktop.development', appIconPath: icon, appIconIndex: 0 });
      window.destroy();
      writeFileSync(${JSON.stringify(report)}, JSON.stringify({ isPackaged: app.isPackaged, icon }));
      app.quit();
    }).catch(error => { console.error(error); app.exit(1); });
  `);
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(executable, [probe], { cwd: root, env, encoding: "utf8", timeout: 30_000 });
  assert.equal(result.status, 0, `${result.error?.message ?? ""}\n${result.stderr}`);
  const verified = JSON.parse(readFileSync(report, "utf8"));
  assert.equal(verified.isPackaged, false);
  console.log("PASS: unpackaged development runtime loads the project icon and creates a native window.");
}
