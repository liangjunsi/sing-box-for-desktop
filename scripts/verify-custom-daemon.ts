// Synthetic, local-only integration check. Uses an isolated daemon data directory.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { createClient } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { ApplicationService, DesktopService } from "../src/shared/gen/experimental/boxdd/desktop_service_pb";
import { ManagedService } from "../src/shared/gen/daemon/managed_service_pb";
import { StartedService, ServiceStatus_Type } from "../src/shared/gen/daemon/started_service_pb";
import { normalizeSubscription } from "../src/custom/subscription";
import { nodeConfig, selectConfig } from "../src/custom/desktop/config";
import { readWindowsProxy, writeWindowsProxy, systemProxyConfig } from "../src/custom/desktop/windowsProxy";
import type { ProxySnapshot } from "../src/custom/desktop/windowsProxy";

const temporary = createServer();
await new Promise<void>((done) => temporary.listen(0, "127.0.0.1", done));
const address = temporary.address();
if (!address || typeof address === "string") throw new Error("test port unavailable");
const port = address.port;
await new Promise<void>((done, reject) => temporary.close((error) => error ? reject(error) : done()));
const directory = resolve("bin/custom-daemon-verify", `${process.pid}-${Date.now()}`);
await mkdir(directory, { recursive: true });
const daemon = spawn(resolve("bin/sing-box-daemon.exe"), ["run", "--working-directory", directory, "--listen", `127.0.0.1:${port}`], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
let stderr = "";
daemon.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-4096); });
const transport = createGrpcTransport({ baseUrl: `http://127.0.0.1:${port}` });
const desktop = createClient(DesktopService, transport);
const application = createClient(ApplicationService, transport);
const managed = createClient(ManagedService, transport);
const started = createClient(StartedService, transport);
const delay = (ms: number) => new Promise((done) => setTimeout(done, ms));
let snapshot: ProxySnapshot | null = null;
let restored = false;
const subscriptionIndex = process.argv.indexOf("--subscription-url");
const subscriptionURL = subscriptionIndex >= 0 ? process.argv[subscriptionIndex + 1] : undefined;
try {
  let ready = false;
  for (let attempt = 0; attempt < 50; attempt++) {
    if (daemon.exitCode !== null) throw new Error(`test daemon exited: ${stderr}`);
    try { await desktop.getDaemonInfo({}, { timeoutMs: 200 }); ready = true; break; } catch { await delay(100); }
  }
  assert.ok(ready, "daemon startup timed out");
  await desktop.claimService({}, { timeoutMs: 5000 });
  if (subscriptionURL) {
    try {
      const response = await fetch(subscriptionURL, { headers: { "User-Agent": "SFW (sing-box 1.14.2; language en)" }, signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error();
      const normalized = normalizeSubscription(await response.text(), "skip");
      await application.checkConfig({ content: normalized.content }, { timeoutMs: 5000 });
      const formatted = (await application.formatConfig({ content: normalized.content }, { timeoutMs: 5000 })).content;
      const nodes = nodeConfig(formatted);
      await application.checkConfig({ content: systemProxyConfig(selectConfig(formatted, nodes.selected)).content }, { timeoutMs: 5000 });
      console.log(JSON.stringify({ subscriptionValidated: true, nodes: nodes.nodes.length, skipped: normalized.skipped.length }));
    } catch { throw new Error("Live subscription validation failed; details withheld to protect credentials"); }
  }
  const uri = "vless://00000000-0000-4000-8000-000000000001@127.0.0.1:65530?security=none#Synthetic-A\nvless://00000000-0000-4000-8000-000000000002@127.0.0.1:65531?security=none#Synthetic-B";
  const listener = createServer();
  await new Promise<void>((done) => listener.listen(0, "127.0.0.1", done));
  const listenerAddress = listener.address();
  if (!listenerAddress || typeof listenerAddress === "string") throw new Error("test listener unavailable");
  const testConfig = JSON.parse(normalizeSubscription(uri).content);
  testConfig.inbounds[0].listen_port = listenerAddress.port;
  await new Promise<void>((done, reject) => listener.close((error) => error ? reject(error) : done()));
  const content = JSON.stringify(testConfig);
  await application.checkConfig({ content }, { timeoutMs: 5000 });
  const formatted = (await application.formatConfig({ content }, { timeoutMs: 5000 })).content;
  assert.equal(nodeConfig(formatted).nodes.length, 2);
  const prepared = systemProxyConfig(selectConfig(formatted, "Synthetic-B"));
  await application.checkConfig({ content: prepared.content }, { timeoutMs: 5000 });
  // This check only applies the test proxy when explicitly requested.
  if (process.argv.includes("--proxy-roundtrip")) snapshot = await readWindowsProxy();
  await desktop.startService({ configContent: prepared.content }, { timeoutMs: 10_000 });
  let serviceStarted = false;
  for await (const status of started.subscribeServiceStatus({}, { signal: AbortSignal.timeout(5000) })) {
    if (status.status === ServiceStatus_Type.STARTED) { serviceStarted = true; break; }
  }
  assert.ok(serviceStarted);
  await started.selectOutbound({ groupTag: "PROXY", outboundTag: "Synthetic-A" }, { timeoutMs: 5000 });
  let verifiedSelection = false;
  for await (const groups of started.subscribeGroups({}, { signal: AbortSignal.timeout(5000) })) {
    if (groups.group.some((group) => group.tag === "PROXY" && group.selected === "Synthetic-A")) { verifiedSelection = true; break; }
  }
  assert.ok(verifiedSelection);
  if (snapshot) {
    await writeWindowsProxy({ Flags: 3, Server: prepared.server, Bypass: "<local>", AutoConfig: "" });
    const enabled = await readWindowsProxy();
    assert.equal(enabled.Server, prepared.server); assert.equal(enabled.Flags & 2, 2);
  }
  await managed.stopService({}, { timeoutMs: 5000 });
  if (snapshot) { await writeWindowsProxy(snapshot); assert.deepEqual(await readWindowsProxy(), snapshot); restored = true; }
  console.log(JSON.stringify({ daemonValidated: true, serviceStarted: true, nodeSwitchVerified: true, serviceStopped: true, proxyRoundtrip: restored }));
} finally {
  try { await managed.stopService({}, { timeoutMs: 3000 }); } catch {}
  if (snapshot && !restored) await writeWindowsProxy(snapshot);
  daemon.kill();
}
