import assert from "node:assert/strict";
import test from "node:test";
import { defaultRouting, normalizeRule, parseRouting, routingConfig } from "./routing";
import type { CustomRoutingRule } from "./contracts";

const rule = (target: string, type: "domain" | "ip" = "domain", action: "direct" | "proxy" = "direct", scope: "suffix" | "exact" = "suffix"): CustomRoutingRule => ({ id: crypto.randomUUID(), type, target, action, scope });
test("domain input normalizes IDN, case and trailing dot and rejects unsupported input", () => {
  assert.equal(normalizeRule(rule("例子.中国.")).target, "xn--fsqu00a.xn--fiqs8s");
  assert.equal(normalizeRule(rule(" EXAMPLE.COM. ")).target, "example.com");
  for (const value of ["https://example.com", "example.com/path", "example.com:443", "*.example.com", "a_b.com", "a..com", "1.2.3.4", "[::1]"]) assert.throws(() => normalizeRule(rule(value)), value);
  for (const value of ["localhost", "local", "test.local", "test.lan"]) assert.throws(() => normalizeRule(rule(value, "domain", "proxy")), /本地/);
});
test("IPv4 and IPv6 normalize to network boundaries", () => {
  assert.equal(normalizeRule(rule("192.0.2.123/24", "ip")).target, "192.0.2.0/24");
  assert.equal(normalizeRule(rule("2001:0DB8:0:0:0:0:0:1234/64", "ip")).target, "2001:db8::/64");
  assert.equal(normalizeRule(rule("::ffff:192.0.2.1", "ip")).target, "::ffff:c000:201");
  assert.equal(normalizeRule(rule("::/0", "ip", "proxy")).target, "::/0");
  assert.equal(normalizeRule(rule("0.0.0.0/0", "ip", "proxy")).target, "0.0.0.0/0");
  for (const value of ["1.2.3.4:80", "192.0.2.1/33", "::1/129", "1.2.3.4/", "192.0.2.1/-1", "x"]) assert.throws(() => normalizeRule(rule(value, "ip")), value);
  for (const value of ["127.0.0.1", "192.168.1.0/24", "::1", "fc00::/7", "::ffff:127.0.0.1"]) assert.throws(() => normalizeRule(rule(value, "ip", "proxy")), /直连/);
});
test("settings reject duplicate canonical targets, duplicate IDs and invalid modes", () => {
  assert.throws(() => parseRouting({ ...defaultRouting(), rules: [rule("EXAMPLE.COM"), rule("example.com.")] }), /已存在/);
  assert.throws(() => parseRouting({ ...defaultRouting(), rules: [rule("192.0.2.1/24", "ip"), rule("192.0.2.99/24", "ip")] }), /已存在/);
  assert.throws(() => parseRouting({ ...defaultRouting(), mode: "other" }));
});
const source = JSON.stringify({ inbounds: [{ type: "mixed", listen: "127.0.0.1", listen_port: 10808 }], outbounds: [{ type: "selector", tag: "PROXY", outbounds: ["A"], default: "A" }, { type: "socks", tag: "A", server: "node.example.com", server_port: 1080 }, { type: "direct", tag: "kukuhou-direct" }], dns: { final: "old" }, route: { final: "PROXY", rules: [{ domain: "old.example", outbound: "old" }] } });
test("generated policy replaces subscription rules without mutating source and preserves nodes", () => {
  const rules = [rule("example.com"), rule("sub.example.com", "domain", "proxy"), rule("example.com", "domain", "proxy", "exact"), rule("203.0.113.0/24", "ip"), rule("203.0.113.99", "ip", "proxy")];
  const input = parseRouting({ ...defaultRouting(), rules });
  const config = JSON.parse(routingConfig(source, input, { site: [], ip: [] }));
  assert.equal(config.route.final, "PROXY");
  assert.equal(config.outbounds[1].server, "node.example.com");
  assert.equal(config.outbounds.at(-1).tag, "kukuhou-direct_");
  const domainRules = config.route.rules.filter((r: { domain?: string[]; domain_suffix?: string[] }) => r.domain?.[0] === "example.com" || r.domain_suffix?.[0] === "example.com" || r.domain_suffix?.[0] === "sub.example.com");
  assert.deepEqual(domainRules.map((r: { domain?: string[]; domain_suffix?: string[] }) => r.domain ?? r.domain_suffix), [["example.com"], ["sub.example.com"], ["example.com"]]);
  assert.deepEqual(config.route.rules.filter((r: { ip_cidr?: string[] }) => r.ip_cidr).map((r: { ip_cidr: string[] }) => r.ip_cidr[0]), ["203.0.113.99", "203.0.113.0/24"]);
  assert.equal(config.dns.final, "kukuhou-dns-proxy");
  assert.equal(config.dns.servers[1].detour, "PROXY");
  assert.ok(config.dns.rules.some((r: { domain?: string[] }) => r.domain?.includes("node.example.com")));
  assert.equal(JSON.parse(source).route.rules[0].domain, "old.example");
  const global = JSON.parse(routingConfig(source, { ...input, mode: "global" }, { site: [], ip: [] }));
  assert.deepEqual(global.route.rule_set, []);
  assert.equal(global.route.rules.filter((r: { domain?: string[] }) => r.domain?.includes("example.com")).length, 1);
});

