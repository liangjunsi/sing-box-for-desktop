type Fields = Record<string, unknown>;
export interface SubscriptionResult { content: string; skipped: string[] }

function decodeBase64(value: string): string {
  const encoded = value.replace(/\s/g, "").replace(/-/g, "+").replace(/_/g, "/");
  if (!encoded || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length % 4 === 1) {
    throw new Error("Invalid Base64 subscription");
  }
  return Buffer.from(encoded, "base64").toString("utf8");
}

function integer(value: unknown, name: string, minimum = 1, maximum = 65535): number {
  const result = Number(value);
  if (!Number.isInteger(result) || result < minimum || result > maximum) throw new Error(`Invalid ${name}`);
  return result;
}

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function flag(parameters: URLSearchParams, ...names: string[]): boolean {
  return names.some((name) => ["1", "true"].includes(parameters.get(name)?.toLowerCase() ?? ""));
}

function transport(kind: string, path: string, host: string): Fields | undefined {
  switch (kind || "tcp") {
    case "tcp": return undefined;
    case "ws": return { type: "ws", path: path || "/", ...(host ? { headers: { Host: host } } : {}) };
    case "grpc": return { type: "grpc", service_name: path };
    case "http": case "h2": return { type: "http", path: path || "/", ...(host ? { host: host.split(",") } : {}) };
    case "httpupgrade": return { type: "httpupgrade", path: path || "/", ...(host ? { host } : {}) };
    default: throw new Error("Unsupported transport");
  }
}

function tls(parameters: URLSearchParams, mandatory: boolean): Fields | undefined {
  const security = parameters.get("security") || "";
  if (security && !["none", "tls", "reality"].includes(security)) throw new Error("Unsupported TLS security mode");
  if (!mandatory && security !== "tls" && security !== "reality") return undefined;
  // A certificate fingerprint is not a public-key fingerprint. Never silently discard it.
  if (parameters.get("pinSHA256")) throw new Error("pinSHA256 certificate pinning cannot be converted to sing-box public-key pinning");
  const result: Fields = { enabled: true };
  const serverName = parameters.get("sni") || parameters.get("peer");
  if (serverName) result.server_name = serverName;
  if (flag(parameters, "insecure", "allowInsecure", "allow_insecure")) result.insecure = true;
  const alpn = parameters.get("alpn");
  if (alpn) result.alpn = alpn.split(",").filter(Boolean);
  const fingerprint = parameters.get("fp");
  if (fingerprint || security === "reality") result.utls = { enabled: true, fingerprint: fingerprint || "chrome" };
  if (security === "reality") {
    result.reality = { enabled: true, public_key: required(parameters.get("pbk") ?? undefined, "Reality public key"), short_id: parameters.get("sid") || "" };
  }
  return result;
}

function parseVMess(uri: string): Fields {
  const value = JSON.parse(decodeBase64(uri.slice(8))) as Fields;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid VMess JSON");
  const text = (key: string) => value[key] === undefined ? "" : String(value[key]);
  const parameters = new URLSearchParams();
  if (text("tls")) parameters.set("security", text("tls"));
  if (text("sni") || text("host")) parameters.set("sni", text("sni") || text("host"));
  if (text("alpn")) parameters.set("alpn", text("alpn"));
  if (text("fp")) parameters.set("fp", text("fp"));
  if (text("allowInsecure")) parameters.set("insecure", text("allowInsecure"));
  if (text("type") && text("type") !== "none") throw new Error("Unsupported VMess header camouflage");
  return {
    type: "vmess", tag: text("ps") || "VMess",
    server: required(text("add"), "server"), server_port: integer(value.port, "port"),
    uuid: required(text("id"), "UUID"), security: text("scy") || "auto",
    alter_id: integer(value.aid ?? 0, "alter ID", 0, 65535),
    ...(tls(parameters, false) ? { tls: tls(parameters, false) } : {}),
    ...(transport(text("net"), text("path"), text("host")) ? { transport: transport(text("net"), text("path"), text("host")) } : {}),
  };
}

export function parseNode(uri: string): Fields {
  if (uri.startsWith("vmess://")) return parseVMess(uri);
  const url = new URL(uri);
  const scheme = url.protocol.slice(0, -1).toLowerCase();
  const type = scheme === "hy2" ? "hysteria2" : scheme;
  if (!["vless", "hysteria2", "tuic", "anytls", "trojan"].includes(type)) throw new Error("Unsupported node protocol");
  const parameters = url.searchParams;
  const node: Fields = {
    type, tag: decodeURIComponent(url.hash.slice(1)) || type.toUpperCase(),
    server: required(url.hostname.replace(/^\[|\]$/g, ""), "server"),
    server_port: integer(url.port || 443, "port"),
  };
  const username = decodeURIComponent(url.username);
  const password = decodeURIComponent(url.password);
  if (type === "vless") {
    node.uuid = required(username, "UUID");
    if (parameters.get("encryption") && parameters.get("encryption") !== "none") throw new Error("Unsupported VLESS encryption");
    if (parameters.get("flow")) node.flow = parameters.get("flow");
    const connection = transport(parameters.get("type") || "tcp", parameters.get("serviceName") || parameters.get("path") || "", parameters.get("host") || "");
    if (connection) node.transport = connection;
  } else if (type === "tuic") {
    node.uuid = required(username, "UUID"); node.password = required(password, "password");
    if (parameters.get("congestion_control")) node.congestion_control = parameters.get("congestion_control");
    if (parameters.get("udp_relay_mode")) node.udp_relay_mode = parameters.get("udp_relay_mode");
    if (flag(parameters, "zero_rtt_handshake")) node.zero_rtt_handshake = true;
  } else {
    node.password = required(username + (password ? `:${password}` : ""), "password");
    if (type === "hysteria2" && parameters.get("obfs")) {
      if (parameters.get("obfs") !== "salamander") throw new Error("Unsupported Hysteria2 obfuscation");
      node.obfs = { type: "salamander", password: required(parameters.get("obfs-password") ?? undefined, "obfuscation password") };
    }
    if (type === "trojan") {
      const connection = transport(parameters.get("type") || "tcp", parameters.get("serviceName") || parameters.get("path") || "", parameters.get("host") || "");
      if (connection) node.transport = connection;
    }
  }
  const tlsOptions = tls(parameters, type !== "vless");
  if (tlsOptions) node.tls = tlsOptions;
  return node;
}

export function normalizeSubscription(content: string, unsupported: "reject" | "skip" = "reject"): SubscriptionResult {
  const trimmed = content.replace(/^\uFEFF/, "").trim();
  // Preserve native JSON/JSONC byte-for-byte; sing-box remains the authoritative validator.
  if (/^(?:\{|\/\/|\/\*)/.test(trimmed)) return { content, skipped: [] };
  const decoded = trimmed.includes("://") ? trimmed : decodeBase64(trimmed);
  const lines = decoded.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length) throw new Error("Subscription contains no nodes");
  const nodes: Fields[] = [];
  const skipped: string[] = [];
  const tags = new Set(["PROXY", "DIRECT"]);
  for (const [index, line] of lines.entries()) {
    try {
      const node = parseNode(line);
      const original = String(node.tag);
      let tag = original;
      for (let suffix = 2; tags.has(tag); suffix++) tag = `${original} (${suffix})`;
      tags.add(tag); node.tag = tag; nodes.push(node);
    } catch (error) {
      // Do not include URIs or parser error details, which can contain credentials.
      const reason = error instanceof Error && /^(Unsupported |Missing |Invalid |pinSHA256)/.test(error.message)
        ? error.message : "Malformed node";
      const message = `Node ${index + 1}: ${reason}`;
      if (unsupported === "reject") throw new Error(message);
      skipped.push(message);
    }
  }
  if (!nodes.length) throw new Error("Subscription contains no supported nodes");
  return { skipped, content: JSON.stringify({
    log: { level: "info" },
    dns: { servers: [{ type: "local", tag: "dns-local" }], final: "dns-local" },
    inbounds: [{ type: "mixed", tag: "mixed-in", listen: "127.0.0.1", listen_port: 10808 }],
    outbounds: [{ type: "selector", tag: "PROXY", outbounds: nodes.map((node) => node.tag), default: nodes[0].tag, interrupt_exist_connections: true }, ...nodes, { type: "direct", tag: "DIRECT" }],
    route: { auto_detect_interface: true, default_domain_resolver: "dns-local", final: "PROXY" },
  }, null, 2) };
}
