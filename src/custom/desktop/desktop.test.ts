import assert from "node:assert/strict";
import test from "node:test";
import { AccountApi, AccountError, parseSession, trustedSubscriptionOrigin } from "./accountApi";
import { CompactController } from "./controller";
import type { AccountDependencies, SavedAccount } from "./controller";
import type { AccountSession } from "./contracts";
import { nodeConfig, selectConfig } from "./config";
import { parseProxySnapshot, systemProxyConfig } from "./windowsProxy";
import { configuredAccountApi } from "./developmentAccount";

const session = (): AccountSession => ({ accessToken: "synthetic-token", expiresAt: new Date(Date.now() + 86400_000).toISOString(), user: { id: "test-user", displayName: "测试账号" }, subscriptionUrl: "https://example.invalid/sub", subscriptionStatus: "active" });
const config = (tags = ["A", "B"]) => JSON.stringify({ inbounds: [{ type: "mixed", listen: "127.0.0.1", listen_port: 10808 }], outbounds: [{ type: "selector", tag: "PROXY", outbounds: tags, default: tags[0] }, ...tags.map((tag) => ({ type: "vless", tag }))], route: { final: "PROXY" } });

test("authenticated subscriptions accept only API or explicitly trusted HTTPS origins", () => {
  const api = "https://api.example.invalid";
  const trusted = "https://sub.example.invalid";
  assert.equal(trustedSubscriptionOrigin(api, `${api}/sub`), api);
  assert.equal(trustedSubscriptionOrigin(api, `${trusted}/s/test`, trusted), trusted);
  assert.throws(() => trustedSubscriptionOrigin(api, `${trusted}/s/test`), AccountError);
  for (const url of ["https://sub.example.invalid.evil.invalid/s", "https://other.invalid/s", "http://sub.example.invalid/s", "https://user:pass@sub.example.invalid/s", "https://sub.example.invalid:8443/s"]) {
    assert.throws(() => trustedSubscriptionOrigin(api, url, trusted), AccountError);
  }
});

function fixture(saved: SavedAccount | null = null, selections: Record<string, string> = {}) {
  let running = false; let content = config(); let failSync = false; let failStart = false; let failStop = false;
  let invalid = false; let network = false; let encryption = true;
  const events: string[] = [];
  const deps: AccountDependencies = {
    loadSelection: (userId) => selections[userId] ?? "",
    saveSelection: (userId, selected) => { selections[userId] = selected; },
    load: async () => saved,
    save: async (value) => { saved = encryption ? value : null; events.push(value ? "save" : "erase"); return encryption || !value; },
    cleanup: async (keep) => { events.push(`cleanup:${keep ?? "all"}`); },
    sync: async (_session, id) => { events.push("sync"); if (failSync) throw new Error("private-uri"); return { id: id ?? "managed-profile", content, updated: 123 }; },
    read: async () => content,
    start: async () => { events.push("start"); if (failStart) throw new Error(); running = true; },
    stop: async () => { events.push("stop"); if (failStop) throw new Error(); running = false; },
    select: async (_group, tag) => { events.push(`select:${tag}`); },
    running: () => running,
    changed: () => {},
  };
  const api: AccountApi = new AccountApi("https://example.invalid", async (url, init) => {
    if (invalid) return new Response("SECRET", { status: 401 });
    if (network) throw new Error("private-address");
    if (String(url).endsWith("login")) assert.deepEqual(JSON.parse(String(init?.body)), { account: "test", password: "test", deviceId: api.deviceId });
    return Response.json(session());
  });
  const controller = new CompactController(api, deps);
  return { controller, events, saved: () => saved,
    content: (value: string) => { content = value; }, failSync: () => { failSync = true; }, failStart: () => { failStart = true; },
    failStop: (value = true) => { failStop = value; }, invalid: () => { invalid = true; }, network: () => { network = true; }, encryption: () => { encryption = false; } };
}

test("API validates sessions and redacts server and network errors", async () => {
  assert.equal(parseSession(session()).user.id, "test-user");
  assert.throws(() => parseSession({ ...session(), subscriptionUrl: "http://example.invalid/sub" }));
  assert.throws(() => parseSession({ ...session(), expiresAt: "2000-01-01" }));
  const api = new AccountApi("https://example.invalid", async () => new Response("SECRET", { status: 403 }));
  await assert.rejects(api.login("test", "test"), (error: unknown) => error instanceof AccountError && error.invalidSession && !error.message.includes("SECRET"));
});
test("API preserves service base path and sends session token only in header", async () => {
  const api = new AccountApi("https://example.invalid/service/", async (url, init) => {
    assert.equal(String(url), "https://example.invalid/service/api/client/session");
    assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer synthetic-token");
    assert.equal(init?.redirect, "error"); return Response.json(session());
  });
  await api.session(session());
});
test("selector extraction, duplicate-free parsing and fallback", () => {
  assert.equal(nodeConfig(config(), "B").selected, "B");
  assert.equal(nodeConfig(config(["C"]), "B").selected, "C");
  assert.equal(JSON.parse(selectConfig(config(), "B")).outbounds[0].default, "B");
  assert.throws(() => selectConfig(config(), "missing"));
  assert.throws(() => nodeConfig('{"outbounds":[]}'));
});
test("Windows config uses loopback HTTP listener and rejects TUN and invalid ports", () => {
  const prepared = systemProxyConfig(config());
  assert.equal(prepared.server, "127.0.0.1:10808");
  assert.equal(JSON.parse(prepared.content).inbounds[0].set_system_proxy, false);
  const extra = JSON.parse(config()); extra.inbounds.push({ type: "shadowsocks", tag: "other" });
  assert.ok(!("set_system_proxy" in JSON.parse(systemProxyConfig(JSON.stringify(extra)).content).inbounds[1]));
  assert.throws(() => systemProxyConfig('{"inbounds":[{"type":"tun"}]}'));
  assert.throws(() => systemProxyConfig('{"inbounds":[{"type":"mixed","listen":"0.0.0.0","listen_port":1}]}'));
  assert.throws(() => parseProxySnapshot({ Flags: -1 }));
  assert.deepEqual(parseProxySnapshot({ Flags: 13, Server: "", Bypass: "", AutoConfig: "https://example.invalid/pac" }).Flags, 13);
});
test("login loads nodes without connecting; password is not persisted", async () => {
  const f = fixture(); await f.controller.login("test", "test", true);
  assert.equal(f.controller.state.user?.id, "test-user");
  assert.equal(f.controller.state.nodes.length, 2);
  assert.equal(f.controller.state.phase, "idle");
  assert.ok(!f.events.includes("start")); assert.ok(!JSON.stringify(f.saved()).includes('"password"'));
});

test("TUIC selection survives restart without remembering login and subscription reorder", async () => {
  const selections: Record<string, string> = {};
  const tuicConfig = (tags: string[]) => {
    const value = JSON.parse(config(tags));
    value.outbounds.find((node: { tag: string }) => node.tag === "TUIC").type = "tuic";
    return JSON.stringify(value);
  };
  const first = fixture(null, selections); first.content(tuicConfig(["A", "TUIC"]));
  await first.controller.login("test", "test", false);
  await first.controller.select("TUIC"); await first.controller.shutdown();
  assert.equal(first.saved(), null);
  const restarted = fixture(null, selections); restarted.content(tuicConfig(["NEW", "TUIC", "A"]));
  await restarted.controller.restore(); await restarted.controller.login("test", "test", false);
  assert.equal(restarted.controller.state.selected, "TUIC");
  assert.equal(restarted.controller.state.nodes.find((node) => node.tag === "TUIC")?.protocol, "tuic");
  restarted.content(config(["NEW"])); await restarted.controller.refresh();
  assert.equal(restarted.controller.state.selected, "NEW");
});
test("subscription errors retain login and previous valid nodes", async () => {
  const f = fixture(); await f.controller.login("test", "test", true); f.failSync(); await f.controller.refresh();
  assert.equal(f.controller.state.nodes.length, 2); assert.ok(f.controller.state.user);
  assert.match(f.controller.state.error, /节点加载失败/); assert.ok(!f.controller.state.error.includes("private-uri"));
});
test("connect, live select, deferred update and fallback on removed node", async () => {
  const f = fixture(); await f.controller.login("test", "test", true);
  await f.controller.select("B"); await f.controller.connect(); assert.equal(f.controller.state.phase, "connected");
  await f.controller.select("A"); assert.ok(f.events.includes("select:A"));
  f.content(config(["C"])); await f.controller.refresh();
  assert.equal(f.controller.state.selected, "C"); assert.match(f.controller.state.notice, /下次连接/);
  assert.equal(f.events.filter((event) => event === "start").length, 1);
  await assert.rejects(f.controller.select("C"), /断开后重新连接/);
  await f.controller.disconnect(); assert.equal(f.controller.state.phase, "idle");
});
test("failed connection rolls back service/proxy and supports retry", async () => {
  const f = fixture(); await f.controller.login("test", "test", true); f.failStart();
  await assert.rejects(f.controller.connect()); assert.ok(f.events.includes("stop")); assert.equal(f.controller.state.phase, "failed");
  await f.controller.disconnect(); assert.equal(f.controller.state.phase, "idle");
});
test("logout clears only account-owned resources after stopping", async () => {
  const f = fixture(); await f.controller.login("test", "test", true); await f.controller.connect();
  f.events.length = 0; await f.controller.logout();
  assert.deepEqual(f.events, ["stop", "erase", "cleanup:all"]); assert.equal(f.saved(), null); assert.equal(f.controller.state.user, null);
});
test("failed logout retains account for cleanup retry", async () => {
  const f = fixture(); await f.controller.login("test", "test", true); await f.controller.connect(); f.failStop();
  await assert.rejects(f.controller.logout()); assert.ok(f.controller.state.user);
  f.failStop(false); await f.controller.logout(); assert.equal(f.controller.state.user, null);
});
test("invalid restored session clears cached account", async () => {
  const f = fixture({ session: session(), profileId: "owned", selected: "B" }); f.invalid(); await f.controller.restore();
  assert.equal(f.controller.state.user, null); assert.equal(f.saved(), null); assert.ok(f.events.includes("cleanup:all"));
});
test("network outage restores unexpired account cache and selection", async () => {
  const f = fixture({ session: session(), profileId: "owned", selected: "B" }); f.network(); await f.controller.restore();
  assert.equal(f.controller.state.selected, "B"); assert.equal(f.controller.state.nodes.length, 2);
  await assert.rejects(f.controller.connect()); assert.equal(f.controller.state.phase, "idle");
});
test("unavailable encryption keeps only in-memory login", async () => {
  const f = fixture(); f.encryption(); await f.controller.login("test", "test", true);
  assert.equal(f.saved(), null); assert.match(f.controller.state.notice, /当前运行/); assert.ok(f.controller.state.user);
});
test("service interruption triggers automatic cleanup", async () => {
  const f = fixture(); await f.controller.login("test", "test", true); await f.controller.connect();
  f.controller.reconcile(false, false);
  await f.controller.disconnect(); assert.ok(f.events.includes("stop")); assert.equal(f.controller.state.phase, "idle");
});
test("session user mismatch and expiration cannot reuse a cache", async () => {
  const api = new AccountApi("https://example.invalid", async () => Response.json({ ...session(), user: { id: "other", displayName: "Other" } }));
  await assert.rejects(api.session(session()), (error: unknown) => error instanceof AccountError && error.invalidSession);
  await assert.rejects(api.session({ ...session(), expiresAt: "2000-01-01" }), (error: unknown) => error instanceof AccountError && error.invalidSession);
});

test("development login loads configured subscription and rejects incorrect passwords", async () => {
  const configured = configuredAccountApi(false, "", { enabled: true, subscriptionUrl: "https://example.invalid/sub" });
  assert.equal(configured.developmentLogin?.account, "dev");
  await assert.rejects(configured.api.login("dev", "wrong"));
  const loggedIn = await configured.api.login("dev", "dev123456");
  assert.equal(loggedIn.subscriptionUrl, "https://example.invalid/sub");
  assert.equal((await configured.api.session(loggedIn)).user.id, "development-user");
});
test("packaged builds and non-opted-in development use only real authentication", () => {
  const packaged = configuredAccountApi(true, "https://example.invalid", { enabled: true, subscriptionUrl: "https://example.invalid/sub" });
  assert.equal(packaged.developmentLogin, undefined); assert.equal(packaged.api.baseURL, "https://example.invalid");
  assert.equal(configuredAccountApi(false, "", { subscriptionUrl: "https://example.invalid/sub" }).developmentLogin, undefined);
});

test("device identity is attached to login, session and logout", async () => {
  const device = crypto.randomUUID(); let loginBody: unknown;
  const api = new AccountApi("https://example.invalid", async (url, init) => {
    if (String(url).endsWith("login")) loginBody = JSON.parse(String(init?.body));
    else assert.equal(new Headers(init?.headers).get("X-Client-Device-Id"), device);
    return Response.json(session());
  }, device);
  await api.login("test", "test"); await api.session(session()); await api.logout(session());
  assert.deepEqual(loginBody, { account: "test", password: "test", deviceId: device });
});
test("takeover invalidation stops connection and removes account cache", async () => {
  const f = fixture(); await f.controller.login("test", "test", true); await f.controller.connect(); f.invalid();
  await assert.rejects(f.controller.verify());
  assert.equal(f.controller.state.user, null); assert.equal(f.saved(), null); assert.ok(f.events.includes("stop"));
});
test("unverified connections stop after 120 seconds, while short outages keep them", async () => {
  const f = fixture(); await f.controller.login("test", "test", true); await f.controller.connect(); f.network();
  await assert.rejects(f.controller.verify(performance.now())); assert.equal(f.controller.state.phase, "connected");
  await assert.rejects(f.controller.verify(performance.now() + 120_001)); assert.equal(f.controller.state.phase, "idle");
});
test("non-active subscription status prevents new connection", async () => {
  const value = { ...session(), subscriptionStatus: "expired" as const };
  const api = new AccountApi("https://example.invalid", async () => Response.json(value));
  let starts = 0;
  const controller = new CompactController(api, { load: async () => null, save: async () => true, cleanup: async () => {}, read: async () => config(), sync: async () => ({id:"profile",content:config(),updated:1}), start: async () => { starts++; }, stop: async () => {}, select: async () => {}, running: () => false, changed: () => {} });
  await controller.login("test", "test", false); assert.equal(controller.state.user?.id, "test-user"); assert.equal(controller.state.nodes.length, 0); await assert.rejects(controller.connect(), /额度耗尽/); assert.equal(starts, 0);
});
