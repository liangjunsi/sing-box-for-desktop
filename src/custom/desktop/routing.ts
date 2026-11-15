import { isIP } from "node:net";
import { domainToASCII } from "node:url";
import type { CustomRoutingRule, RoutingSettings } from "./contracts";
import { nodeConfig } from "./config";

export const defaultRouting = (mode: RoutingSettings["mode"] = "smart"): RoutingSettings => ({ mode, rules: [], version: 1 });
const privateNetworks = ["0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12", "192.168.0.0/16", "::/128", "::1/128", "fc00::/7", "fe80::/10"];
function ipNumber(ip: string): bigint {
  if (isIP(ip) === 4) return ip.split(".").reduce((n, v) => (n << 8n) | BigInt(v), 0n);
  let expanded = ip;
  if (ip.includes(".")) {
    const at = ip.lastIndexOf(":"); const v4 = ipNumber(ip.slice(at + 1));
    expanded = `${ip.slice(0, at)}:${(v4 >> 16n).toString(16)}:${(v4 & 65535n).toString(16)}`;
  }
  const halves = expanded.split("::"); const left = halves[0] ? halves[0].split(":") : []; const right = halves[1] ? halves[1].split(":") : [];
  const parts = halves.length === 2 ? [...left, ...Array<string>(8 - left.length - right.length).fill("0"), ...right] : left;
  return parts.reduce((n, v) => (n << 16n) | BigInt(`0x${v}`), 0n);
}
function normalizedNetwork(target: string) {
  const parts = target.split("/"); const family = isIP(parts[0]); const bits = family === 4 ? 32 : 128;
  if (!family || parts.length > 2 || (parts.length === 2 && !/^\d+$/.test(parts[1]))) throw new Error("请输入有效的 IP 或 CIDR 网段，不包含端口");
  const prefix = parts.length === 2 ? Number(parts[1]) : bits;
  if (prefix < 0 || prefix > bits) throw new Error(`网段前缀必须在 0 到 ${bits} 之间`);
  const n = (ipNumber(parts[0]) >> BigInt(bits - prefix)) << BigInt(bits - prefix);
  const address = family === 4 ? [24, 16, 8, 0].map(s => Number((n >> BigInt(s)) & 255n)).join(".") : new URL(`http://[${Array.from({ length: 8 }, (_, i) => ((n >> BigInt(112 - i * 16)) & 65535n).toString(16)).join(":")}]`).hostname.slice(1, -1);
  return { target: prefix === bits ? address : `${address}/${prefix}`, address, prefix, family };
}
function isLocalNetwork(network: ReturnType<typeof normalizedNetwork>): boolean {
  if (privateNetworks.some(value => {
    const [address, length] = value.split("/"); const prefix = Number(length);
    return isIP(address) === network.family && network.prefix >= prefix && (ipNumber(address) >> BigInt((network.family === 4 ? 32 : 128) - prefix)) === (ipNumber(network.address) >> BigInt((network.family === 4 ? 32 : 128) - prefix));
  })) return true;
  if (network.family === 6 && network.prefix >= 96 && ipNumber(network.address) >> 32n === 65535n) {
    const value = ipNumber(network.address) & 0xffffffffn;
    return isLocalNetwork(normalizedNetwork(`${[24, 16, 8, 0].map(s => Number((value >> BigInt(s)) & 255n)).join(".")}/${network.prefix - 96}`));
  }
  return false;
}
export function normalizeRule(value: unknown): CustomRoutingRule {
  const r = value as CustomRoutingRule;
  if (!r || typeof r.id !== "string" || !/^[a-zA-Z0-9-]{1,64}$/.test(r.id) || !["domain", "ip"].includes(r.type) || !["direct", "proxy"].includes(r.action) || !["suffix", "exact"].includes(r.scope) || typeof r.target !== "string") throw new Error("规则格式无效");
  let target = r.target.trim();
  if (r.type === "domain") {
    if (/[\s/:\\*?#@\[\]%]/.test(target)) throw new Error("请输入域名，不包含协议、端口、路径或通配符");
    target = domainToASCII(target.replace(/\.$/, "")).toLowerCase();
    if (!target || target.length > 253 || isIP(target) || !target.split(".").every(part => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(part))) throw new Error("请输入域名，不包含协议、端口、路径或通配符");
    if (r.action === "proxy" && /(?:^|\.)(?:localhost|local|lan)$/.test(target)) throw new Error("本地域名始终直连，不支持走 VPN");
  } else {
    const network = normalizedNetwork(target); target = network.target;
    if (r.action === "proxy" && isLocalNetwork(network)) throw new Error("本地和私有地址始终直连，不支持走 VPN");
  }
  return { id: r.id, type: r.type, target, scope: r.type === "ip" ? "exact" : r.scope, action: r.action };
}
export function parseRouting(value: unknown): RoutingSettings {
  const r = value as RoutingSettings;
  if (!r || !["smart", "global"].includes(r.mode) || !Number.isSafeInteger(r.version) || r.version < 1 || !Array.isArray(r.rules) || r.rules.length > 1000) throw new Error("路由设置无效，最多支持 1000 条规则");
  const rules = r.rules.map(normalizeRule); const targets = new Set<string>(); const ids = new Set<string>();
  for (const rule of rules) {
    const key = `${rule.type}:${rule.scope}:${rule.target}`;
    if (targets.has(key) || ids.has(rule.id)) throw new Error("规则已存在，请编辑已有规则");
    targets.add(key); ids.add(rule.id);
  }
  return { mode: r.mode, version: r.version, rules };
}
type Fields = Record<string, unknown>;
export function routingConfig(content: string, settings: RoutingSettings, resources: { site: Fields[]; ip: Fields[] }): string {
  const config = JSON.parse(content); const model = nodeConfig(content);
  const outbounds: Fields[] = config.outbounds;
  const proxy = model.group || model.selected;
  const used = new Set<string>(outbounds.map(o => String(o.tag)));
  const tag = (base: string) => { let name = base; while (used.has(name)) name += "_"; used.add(name); return name; };
  const direct = tag("kukuhou-direct"), dnsLocal = tag("kukuhou-dns-local"), dnsProxy = tag("kukuhou-dns-proxy"), site = tag("kukuhou-cn-site"), ip = tag("kukuhou-cn-ip");
  outbounds.push({ type: "direct", tag: direct });
  // Remove subscription resolver references; all node bootstrap queries use local DNS.
  for (const outbound of outbounds) if (outbound.domain_resolver !== undefined) outbound.domain_resolver = dnsLocal;
  const domains = settings.rules.filter(r => r.type === "domain").sort((a, b) => Number(b.scope === "exact") - Number(a.scope === "exact") || b.target.split(".").length - a.target.split(".").length);
  const ips = settings.rules.filter(r => r.type === "ip").sort((a, b) => normalizedNetwork(b.target).prefix - normalizedNetwork(a.target).prefix);
  const match = (r: CustomRoutingRule): Fields => ({ [r.type === "ip" ? "ip_cidr" : r.scope === "exact" ? "domain" : "domain_suffix"]: [r.target] });
  const localDomains = { domain_suffix: ["localhost", "local", "lan"] };
  const rules: Fields[] = [
    { ...localDomains, action: "route", outbound: direct },
    // Resolve with the domain-aware DNS policy before enforcing private-address protection.
    { action: "resolve" },
    { ip_is_private: true, action: "route", outbound: direct },
    ...domains.map(r => ({ ...match(r), action: "route", outbound: r.action === "direct" ? direct : proxy })),
  ];
  if (settings.mode === "smart") rules.push({ rule_set: [site], action: "route", outbound: direct });
  rules.push(...ips.map(r => ({ ...match(r), action: "route", outbound: r.action === "direct" ? direct : proxy })));
  if (settings.mode === "smart") rules.push({ rule_set: [ip], action: "route", outbound: direct });
  config.route = { auto_detect_interface: true, default_domain_resolver: dnsLocal, final: proxy, rules, rule_set: settings.mode === "smart" ? [{ type: "inline", tag: site, rules: resources.site }, { type: "inline", tag: ip, rules: resources.ip }] : [] };
  const bootstrap = outbounds.flatMap(o => typeof o.server === "string" && !isIP(o.server) ? [o.server] : []);
  config.dns = { servers: [{ type: "local", tag: dnsLocal }, { type: "https", tag: dnsProxy, server: "1.1.1.1", path: "/dns-query", detour: proxy }], rules: [
    { ...localDomains, action: "route", server: dnsLocal },
    ...(bootstrap.length ? [{ domain: bootstrap, action: "route", server: dnsLocal }] : []),
    ...domains.map(r => ({ ...match(r), action: "route", server: r.action === "direct" ? dnsLocal : dnsProxy })),
    ...(settings.mode === "smart" ? [{ rule_set: [site], action: "route", server: dnsLocal }] : []),
  ], final: dnsProxy, independent_cache: true };
  return JSON.stringify(config, null, 2);
}
