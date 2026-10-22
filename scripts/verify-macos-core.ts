import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createServer, request } from "node:http";
import { createServer as createTcpServer } from "node:net";
import * as net from "node:net";
import { join, resolve } from "node:path";
import { createClient } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { ManagedService } from "../src/shared/gen/daemon/managed_service_pb";
import { StartedService } from "../src/shared/gen/daemon/started_service_pb";
import { DesktopService } from "../src/shared/gen/experimental/boxdd/desktop_service_pb";
const directory = await mkdtemp("/tmp/kukuhou-verify-");
const socket = join(directory, "daemon.sock");
const binaryDirectory = resolve(process.argv[2] ?? "bin/darwin/arm64");
const child = spawn(join(binaryDirectory, "daemon-supervisor"), [join(binaryDirectory, "sing-box-daemon"), directory, socket], { stdio: ["pipe", "ignore", "pipe"] });
let stderr = "";
child.stderr.on("data", data => { stderr += String(data); });
const origin = createServer((_req, res) => res.end("origin"));
const upstream = createServer((_req, res) => res.end("via-upstream"));
upstream.on("connect", (_req, socket) => {
  socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
  socket.once("data", () => socket.end("HTTP/1.1 200 OK\r\nContent-Length: 12\r\nConnection: close\r\n\r\nvia-upstream"));
});
async function listen(server: ReturnType<typeof createServer>) { await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); return (server.address() as net.AddressInfo).port; }
const originPort = await listen(origin), upstreamPort = await listen(upstream);
const reserve = createTcpServer();
await new Promise<void>(resolve => reserve.listen(0, "127.0.0.1", resolve));
const proxyPort = (reserve.address() as net.AddressInfo).port;
await new Promise<void>(resolve => reserve.close(() => resolve()));
async function get() {
  return new Promise<string>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: proxyPort, path: `http://127.0.0.1:${originPort}/`, headers: { Host: `127.0.0.1:${originPort}` }, timeout: 5000 }, res => { let body = ""; res.on("data", data => { body += String(data); }); res.on("end", () => resolve(body)); });
    req.on("error", reject); req.on("timeout", () => req.destroy(new Error("proxy request timed out"))); req.end();
  });
}
try {
  for (let i = 0; i < 100 && !existsSync(socket); i++) { if (child.exitCode !== null) throw new Error(stderr); await new Promise(resolve => setTimeout(resolve, 100)); }
  assert.ok(existsSync(socket), stderr || "daemon socket missing");
  assert.equal((await stat(directory)).mode & 0o077, 0, "private daemon directory");
  const transport = createGrpcTransport({ baseUrl: "http://daemon", nodeOptions: { createConnection: () => net.connect(socket) } });
  const desktop = createClient(DesktopService, transport), managed = createClient(ManagedService, transport), started = createClient(StartedService, transport);
  const info = await desktop.getDaemonInfo({}, { timeoutMs: 5000 });
  assert.ok(info.version);
  await desktop.claimService({}, { timeoutMs: 5000 });
  await desktop.startService({ configContent: JSON.stringify({ inbounds: [{ type: "mixed", listen: "127.0.0.1", listen_port: proxyPort }], outbounds: [{ type: "http", tag: "upstream", server: "127.0.0.1", server_port: upstreamPort }, { type: "direct", tag: "direct" }, { type: "selector", tag: "PROXY", outbounds: ["upstream", "direct"], default: "upstream" }], route: { final: "PROXY" } }) }, { timeoutMs: 5000 });
  assert.equal(await get(), "via-upstream", "traffic reaches selected upstream");
  await started.selectOutbound({ groupTag: "PROXY", outboundTag: "direct" }, { timeoutMs: 5000 });
  assert.equal(await get(), "origin", "node selection changes routing");
  await managed.stopService({}, { timeoutMs: 5000 });
  await assert.rejects(get(), "disconnect closes proxy listener");
  const exited = new Promise<void>((resolve, reject) => { child.once("exit", code => code === 0 ? resolve() : reject(new Error(stderr))); });
  child.stdin.end(); await exited;
  console.log(JSON.stringify({ binaryDirectory, version: info.version, checks: ["private socket directory", "daemon RPC ownership", "proxy traffic via upstream", "node switch", "disconnect listener cleanup", "parent pipe EOF terminates daemon"] }, null, 2));
} finally {
  child.stdin.end(); origin.close(); upstream.close();
  await rm(directory, { recursive: true, force: true });
}
