const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const packages = new Map();
for (const project of [root, path.join(root, "dashboard")]) {
  const store = path.join(project, "node_modules", ".pnpm");
  if (!fs.existsSync(store)) continue;
  for (const entry of fs.readdirSync(store, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const modules = path.join(store, entry.name, "node_modules");
    if (!fs.existsSync(modules)) continue;
    const candidates = [];
    for (const item of fs.readdirSync(modules, { withFileTypes: true })) {
      if (!item.isDirectory() || item.isSymbolicLink()) continue;
      const candidate = path.join(modules, item.name);
      if (item.name.startsWith("@")) {
        for (const scoped of fs.readdirSync(candidate, { withFileTypes: true })) {
          if (scoped.isDirectory() && !scoped.isSymbolicLink()) candidates.push(path.join(candidate, scoped.name));
        }
      } else candidates.push(candidate);
    }
    for (const directory of candidates) {
      const metadataPath = path.join(directory, "package.json");
      if (!fs.existsSync(metadataPath)) continue;
      const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
      const identity = `${metadata.name}@${metadata.version}`;
      if (packages.has(identity)) continue;
      const notices = fs.readdirSync(directory, { withFileTypes: true })
        .filter(file => file.isFile() && /^(licen[cs]e|copying|notice|ofl)([.-].*)?$/i.test(file.name))
        .map(file => `--- ${file.name} ---\n${fs.readFileSync(path.join(directory, file.name), "utf8")}`);
      if (notices.length) packages.set(identity, `${identity}\nDeclared license: ${typeof metadata.license === "string" ? metadata.license : "See license text"}\n${notices.join("\n")}`);
    }
  }
}
const licenses = path.join(root, "resources", "licenses");
fs.mkdirSync(licenses, { recursive: true });
const header = "Notices for installed JavaScript/font dependencies, including build tools.\nThis collection is intentionally broader than runtime dependencies.\nIt is not a complete audit of Go dependencies or bundled drivers.\n\n";
fs.writeFileSync(path.join(licenses, "THIRD-PARTY-NOTICES.txt"), header + [...packages].sort(([a], [b]) => a.localeCompare(b)).map(([, notice]) => notice).join("\n\n========================================\n\n"));
fs.copyFileSync(path.join(root, "node_modules", "electron", "dist", "LICENSE"), path.join(licenses, "Electron-LICENSE.txt"));
fs.copyFileSync(path.join(root, "node_modules", "electron", "dist", "LICENSES.chromium.html"), path.join(licenses, "Chromium-LICENSES.html"));
console.log(`Collected license notices for ${packages.size} installed packages plus Electron/Chromium.`);
