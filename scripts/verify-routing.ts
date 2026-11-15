// Isolated native-core validation. Never changes the user's system proxy.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { createServer, connect } from "node:net";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { createClient } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { ApplicationService, DesktopService } from "../src/shared/gen/experimental/boxdd/desktop_service_pb";
import { ManagedService } from "../src/shared/gen/daemon/managed_service_pb";
import { StartedService } from "../src/shared/gen/daemon/started_service_pb";
import { routingConfig, defaultRouting, normalizeRule } from "../src/custom/desktop/routing";

async function freePort() {
  const server = createServer(); await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>(done => server.close(() => done())); return port;
}
const port = await freePort(), inboundPort = await freePort();
const directory = resolve("bin/routing-verify", `${process.pid}-${Date.now()}`);
await mkdir(directory, { recursive: true });
const daemon = spawn(resolve(process.env.ROUTING_VERIFY_DAEMON || "bin/sing-box-daemon.exe"), ["run", "--working-directory", directory, "--listen", `127.0.0.1:${port}`], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
let stderr = "", lastError = ""; daemon.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-8000); });
const transport = createGrpcTransport({ baseUrl: `http://127.0.0.1:${port}` });
const desktop = createClient(DesktopService, transport), application = createClient(ApplicationService, transport), managed = createClient(ManagedService, transport);
const started = createClient(StartedService, transport);
try {
  let ready = false;
  for (let attempt = 0; attempt < 50; attempt++) {
    if (daemon.exitCode !== null) throw new Error(stderr);
    try { await desktop.getDaemonInfo({}, { timeoutMs: 200 }); ready = true; break; } catch (error) { lastError = String(error); await new Promise(done => setTimeout(done, 100)); }
  }
  assert.ok(ready, `isolated daemon ready: ${lastError} ${stderr}`); await desktop.claimService({});
  const manifest = JSON.parse((await readFile("resources/routing/manifest.json", "utf8")).replace(/^\uFEFF/, "")) as { file: string; sha256: string }[];
  for (const entry of manifest) assert.equal(createHash("sha256").update(await readFile(resolve("resources/routing", entry.file))).digest("hex"), entry.sha256);
  const source = JSON.stringify({ inbounds: [{ type: "mixed", listen: "127.0.0.1", listen_port: inboundPort }], outbounds: [{ type: "selector", tag: "PROXY", outbounds: ["test-node"], default: "test-node" }, { type: "socks", tag: "test-node", server: "127.0.0.1", server_port: 65534 }], route: { final: "PROXY" } });
  for (const mode of ["smart", "global"] as const) {
    const settings = defaultRouting(mode);
    settings.rules = [normalizeRule({ id: "domain", type: "domain", target: "direct.example.com", scope: "suffix", action: "direct" }), normalizeRule({ id: "proxy-domain", type: "domain", target: "proxy.baidu.com", scope: "suffix", action: "proxy" }), normalizeRule({ id: "ip", type: "ip", target: "8.8.4.4", scope: "exact", action: "direct" }), normalizeRule({ id: "proxy-ip", type: "ip", target: "223.5.5.5", scope: "exact", action: "proxy" })];
    const content = routingConfig(source, settings, { site: JSON.parse(await readFile("resources/routing/geosite-cn.json", "utf8")).rules, ip: JSON.parse(await readFile("resources/routing/geoip-cn.json", "utf8")).rules });
    await application.checkConfig({ content }, { timeoutMs: 10000 });
    // Deterministic DNS fixtures test routing without depending on a real VPN account or DoH.
    const fixture = JSON.parse(content);
    fixture.log = { level: "debug" };
    const predefined = { "www.baidu.com": ["223.6.6.6"], "www.google.com": ["8.8.8.8"], "proxy.baidu.com": ["223.5.5.5"], "direct.example.com": ["8.8.4.4"], "private.example.com": ["127.0.0.1"] };
    fixture.dns.servers.unshift({ type: "hosts", tag: "fixture-dns", predefined });
    fixture.dns.rules.unshift({ domain: Object.keys(predefined), action: "route", server: "fixture-dns" });
    await desktop.startService({ configContent: JSON.stringify(fixture) }, { timeoutMs: 10000 });
    const logs: string[] = []; const abort = new AbortController();
    const capture = (async () => { try { for await (const event of started.subscribeLog({}, { signal: abort.signal })) logs.push(...event.messages.map(m => m.message)); } catch { /* Stream canceled after assertions. */ } })();
    try {
      for (const [target, expected] of [["www.baidu.com", mode === "smart" ? "direct" : "socks"], ["www.google.com", "socks"], ["proxy.baidu.com", "socks"], ["direct.example.com", "direct"], ["8.8.4.4", "direct"], ["223.5.5.5", "socks"], ["223.6.6.6", mode === "smart" ? "direct" : "socks"], ["private.example.com", "direct"], ["127.0.0.1", "direct"]]) {
        const start = logs.length;
        const socket = connect(inboundPort, "127.0.0.1"); socket.on("error", () => {});
        socket.on("connect", () => socket.write(`CONNECT ${target}:9 HTTP/1.1\r\nHost: ${target}:9\r\n\r\n`));
        try {
          let matched = false;
          for (let attempt = 0; attempt < 30; attempt++) {
            await new Promise(done => setTimeout(done, 100));
            const resolved = predefined[target as keyof typeof predefined]?.[0] ?? target;
            matched = logs.slice(start).some(line => line.includes(`outbound/${expected}[`) && (line.includes(`${target}:9`) || line.includes(`${resolved}:9`)));
            if (matched) break;
          }
          assert.ok(matched, `${mode} ${target} -> ${expected}: ${logs.slice(start).join("\n")}`);
        } finally { socket.destroy(); }
      }
    } finally { abort.abort(); await capture; }
    await managed.stopService({}, { timeoutMs: 5000 });
    console.log(`${mode}: native check, startup and 9 actual routing log assertions passed`);
  }
} finally {
  try { await managed.stopService({}, { timeoutMs: 2000 }); } catch { /* Isolated daemon may already be stopped. */ }
  daemon.kill();
}
