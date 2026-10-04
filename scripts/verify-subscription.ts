import { createClient } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { normalizeSubscription } from "../src/custom/subscription";
import { ApplicationService } from "../src/shared/gen/experimental/boxdd/desktop_service_pb";

const url = process.argv[2];
if (!url) throw new Error("Pass a subscription URL as the first argument");
const response = await fetch(url, { headers: { "User-Agent": "SFW (sing-box 1.14.2; language en)" }, signal: AbortSignal.timeout(30000) });
if (!response.ok) throw new Error(`Subscription returned HTTP ${response.status}`);
const result = normalizeSubscription(await response.text(), process.argv.includes("--skip-unsupported") ? "skip" : "reject");
const client = createClient(ApplicationService, createGrpcTransport({ baseUrl: process.env.SUBSCRIPTION_VERIFY_DAEMON_ADDRESS || "http://127.0.0.1:19431" }));
try {
  await client.checkConfig({ content: result.content }, { timeoutMs: 15000 });
} catch {
  throw new Error("Generated configuration failed sing-box validation (details withheld to protect credentials)");
}
const config = JSON.parse(result.content);
console.log(JSON.stringify({ valid: true, nodeCount: config.outbounds.filter((node: { type: string }) => !["selector", "direct"].includes(node.type)).length, skipped: result.skipped }));
