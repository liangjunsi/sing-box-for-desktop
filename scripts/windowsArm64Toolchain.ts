import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { sync as spawnSync } from "cross-spawn";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const toolchain = path.join(root, "bin", "windows-share-toolchain");
const version = "0.9.0";
const sdkVersion = "10.0.26100";
const crtVersion = "14.44.17.14";

function run(command: string, args: string[]): string {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

async function download(url: string): Promise<Buffer> {
  const response = await fetch(url, { signal: AbortSignal.timeout(300_000) });
  if (!response.ok) throw new Error(`Download failed (${response.status}): ${url}`);
  return Buffer.from(await response.arrayBuffer());
}

// Keep the cross-compilation tools and libraries inside the ignored build cache.
export async function ensureWindowsArm64Toolchain() {
  if (process.arch !== "x64") {
    throw new Error("The Windows ARM64 cross-build toolchain requires an x64 host");
  }
  const sdk = path.join(toolchain, "arm64-sdk");
  const marker = path.join(sdk, ".versions.json");
  const versions = JSON.stringify({ sdk: sdkVersion, crt: crtVersion });
  const libraries = ["crt/lib/aarch64/libcmt.lib", "sdk/lib/ucrt/aarch64/ucrt.lib", "sdk/lib/um/aarch64/windowsapp.lib"];
  if (!libraries.every((library) => fs.existsSync(path.join(sdk, library))) ||
      !fs.existsSync(marker) || fs.readFileSync(marker, "utf8") !== versions) {
    const name = `xwin-${version}-x86_64-pc-windows-msvc`;
    const directory = path.join(toolchain, "xwin-download");
    const archive = path.join(directory, "xwin.tar.gz");
    const url = `https://github.com/Jake-Shadle/xwin/releases/download/${version}/${name}.tar.gz`;
    console.info("[package:arm64] preparing Windows SDK and C++ libraries with xwin");
    fs.mkdirSync(directory, { recursive: true });
    const expected = (await download(`${url}.sha256`)).toString("utf8").trim().split(/\s+/u)[0];
    if (!/^[a-f0-9]{64}$/iu.test(expected)) throw new Error("Invalid xwin checksum");
    let bytes: Buffer | undefined = fs.existsSync(archive) ? fs.readFileSync(archive) : undefined;
    if (!bytes || createHash("sha256").update(bytes).digest("hex") !== expected.toLowerCase()) {
      bytes = await download(url);
      if (createHash("sha256").update(bytes).digest("hex") !== expected.toLowerCase()) {
        throw new Error("xwin archive checksum mismatch");
      }
      fs.writeFileSync(archive, bytes);
    }
    run("tar", ["-xf", archive, "-C", directory]);
    const executable = path.join(directory, name, "xwin.exe");
    if (run(executable, ["--version"]) !== `xwin ${version}`) throw new Error("Unexpected xwin version");
    run(executable, ["--accept-license", "--arch", "aarch64", "--sdk-version", sdkVersion,
      "--crt-version", crtVersion, "--cache-dir", path.join(toolchain, "xwin-cache"),
      "splat", "--output", sdk]);
    if (!libraries.every((library) => fs.existsSync(path.join(sdk, library)))) {
      throw new Error("ARM64 SDK is incomplete");
    }
    fs.writeFileSync(marker, versions);
  }
  const sysroot = run("rustc", ["--print", "sysroot"]);
  const host = /^host: (.+)$/mu.exec(run("rustc", ["-vV"]))?.[1];
  if (!host) throw new Error("Rust host target is missing");
  const linker = path.join(sysroot, "lib", "rustlib", host, "bin", "rust-lld.exe");
  if (!fs.existsSync(linker)) throw new Error(`Rust linker is missing: ${linker}`);
  return { sdk, linker };
}
