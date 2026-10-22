import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { Data, NtExecutable, NtExecutableResource, Resource } from "resedit";

// Windows can read the executable's icon before BrowserWindow/setAppDetails
// take effect. Keep a branded development runtime outside node_modules so
// dependency reinstalls and Electron upgrades cannot undo the startup icon.
export function prepareWindowsDevelopmentRuntime(repositoryRoot: string): void {
  if (process.platform !== "win32") return;

  const require = createRequire(import.meta.url);
  const electronPath = require("electron") as string;
  const electronVersion = require("electron/package.json").version as string;
  const electronStat = statSync(electronPath);
  const icon = readFileSync(join(repositoryRoot, "resources", "icon.ico"));
  const fingerprint = createHash("sha256")
    .update(`electron-name-v2:${electronVersion}:${electronStat.size}:${electronStat.mtimeMs}`)
    .update(icon).digest("hex").slice(0, 16);
  const runtimeDirectory = join(repositoryRoot, "bin", "development-electron", fingerprint);
  // Electron uses the executable name to determine app.isPackaged on Windows.
  // Renaming it makes development resource/data paths resolve as an install.
  const executablePath = join(runtimeDirectory, "electron.exe");
  const readyPath = join(runtimeDirectory, ".kukuhou-ready");

  if (!existsSync(readyPath) || !existsSync(executablePath)) {
    mkdirSync(runtimeDirectory, { recursive: true });
    cpSync(dirname(electronPath), runtimeDirectory, { recursive: true });
    const executable = NtExecutable.from(readFileSync(electronPath), { ignoreCert: true });
    const resources = NtExecutableResource.from(executable);
    const icons = Data.IconFile.from(icon).icons.map((entry) => entry.data);
    for (const group of Resource.IconGroupEntry.fromEntries(resources.entries)) {
      Resource.IconGroupEntry.replaceIconsForResource(resources.entries, group.id, group.lang, icons);
    }
    resources.outputResource(executable);
    // Publish only the complete executable; an interrupted preparation retries.
    const temporaryPath = `${executablePath}.tmp`;
    writeFileSync(temporaryPath, Buffer.from(executable.generate()));
    renameSync(temporaryPath, executablePath);
    writeFileSync(readyPath, fingerprint);
  }

  process.env.ELECTRON_EXEC_PATH = executablePath;
}
