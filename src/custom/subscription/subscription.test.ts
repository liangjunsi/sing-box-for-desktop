import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeSubscription, parseNode } from "./index";

const uuid = "00000000-0000-4000-8000-000000000001";
test("preserves native JSON and JSONC without rewriting", () => {
  for (const content of ['{ "outbounds": [] }\n', '// comment\n{}', '/* comment */\n{}']) {
    assert.equal(normalizeSubscription(content).content, content);
  }
});
test("Base64 and URL-safe subscriptions produce unique selector tags", () => {
  const lines = [`vless://${uuid}@example.com:443?security=reality&pbk=key&sid=ab&flow=xtls-rprx-vision#PROXY`, `vless://${uuid}@example.org:8443#PROXY`].join("\n");
  for (const content of [lines, Buffer.from(lines).toString("base64"), Buffer.from(lines).toString("base64url")]) {
    const config = JSON.parse(normalizeSubscription(content).content);
    assert.deepEqual(config.outbounds[0].outbounds, ["PROXY (2)", "PROXY (3)"]);
    assert.equal(config.outbounds[1].tls.reality.public_key, "key");
    assert.equal(config.outbounds[1].flow, "xtls-rprx-vision");
    assert.equal(config.inbounds[0].listen, "127.0.0.1");
  }
});
test("VMess maps WebSocket, alter ID, SNI and TLS", () => {
  const node = parseNode(`vmess://${Buffer.from(JSON.stringify({ add: "example.com", port: "443", id: uuid, aid: "0", net: "ws", type: "none", path: "/ws", host: "cdn.example.com", tls: "tls", sni: "tls.example.com", ps: "WS" })).toString("base64")}`);
  assert.deepEqual(node.transport, { type: "ws", path: "/ws", headers: { Host: "cdn.example.com" } });
  assert.equal((node.tls as Record<string, unknown>).server_name, "tls.example.com");
  assert.equal(node.security, "auto");
});
test("parses mandatory TLS protocols, IPv6 and encoded credentials", () => {
  assert.equal(parseNode("anytls://a%3Ab@[::1]:443?sni=example.com&allowInsecure=1").password, "a:b");
  const tuic = parseNode(`tuic://${uuid}:a%40b@example.com:443?alpn=h3&udp_relay_mode=native&congestion_control=bbr`);
  assert.equal(tuic.password, "a@b");
  assert.equal(tuic.congestion_control, "bbr");
  assert.deepEqual((tuic.tls as Record<string, unknown>).alpn, ["h3"]);
  assert.deepEqual(parseNode("hy2://password@example.com:443?obfs=salamander&obfs-password=secret").obfs, { type: "salamander", password: "secret" });
});
test("never silently drops certificate pinning or exposes credentials", () => {
  const pinned = "hy2://TOP_SECRET@example.com:443?pinSHA256=certificate-hash";
  assert.throws(() => normalizeSubscription(pinned), /pinSHA256/);
  const result = normalizeSubscription(`${pinned}\nanytls://password@example.com:443`, "skip");
  assert.equal(result.skipped.length, 1);
  assert.ok(!result.skipped.join().includes("TOP_SECRET"));
  assert.throws(() => normalizeSubscription(pinned, "skip"), /no supported nodes/);
  assert.throws(() => normalizeSubscription("vless://TOP_SECRET@example.com:invalid"), (error: unknown) => error instanceof Error && !error.message.includes("TOP_SECRET"));
});
test("rejects empty subscriptions, invalid ports and unsupported transports", () => {
  assert.throws(() => normalizeSubscription(""));
  assert.throws(() => parseNode(`vless://${uuid}@example.com:0`), /port/);
  assert.throws(() => parseNode(`vless://${uuid}@example.com:443?type=xhttp`), /transport/);
});
