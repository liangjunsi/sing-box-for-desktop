import assert from "node:assert/strict";
import test from "node:test";
import { AccountApi, AccountError, parseSession, trustedSubscriptionOrigin } from "./accountApi";
import { CompactController } from "./controller";
import type { AccountDependencies, SavedAccount } from "./controller";
import type { AccountSession } from "./contracts";
import { nodeConfig, selectConfig } from "./config";
import { parseProxySnapshot, systemProxyConfig } from "./windowsProxy";
import { planDisplay } from "./planDisplay";
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
  let responseSession = session();
  let invalid = false; let network = false; let encryption = true; let serviceStatus = 200;
  const events: string[] = [];
  const requests: string[] = [];
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
    requests.push(String(url));
    if (invalid) return new Response("SECRET", { status: 401 });
    if (network) throw new Error("private-address");
    if (serviceStatus !== 200) return new Response("SECRET", { status: serviceStatus });
    if (String(url).endsWith("login")) assert.deepEqual(JSON.parse(String(init?.body)), { account: "test", password: "test", deviceId: api.deviceId });
    return Response.json(responseSession);
  });
  const controller = new CompactController(api, deps);
  return { controller, events, requests, responseSession: (value: AccountSession) => { responseSession = value; }, saved: () => saved,
    content: (value: string) => { content = value; }, failSync: () => { failSync = true; }, failStart: () => { failStart = true; },
    failStop: (value = true) => { failStop = value; }, invalid: () => { invalid = true; }, network: (value = true) => { network = value; }, serviceStatus: (value: number) => { serviceStatus = value; }, encryption: () => { encryption = false; } };
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
test("startup restores cached account and nodes without validation or subscription download", async () => {
  const f = fixture({ session: session(), profileId: "owned", selected: "B", lastUpdated: 456 });
  await f.controller.restore();
  assert.equal(f.controller.state.user?.id, "test-user");
  assert.equal(f.controller.state.selected, "B");
  assert.equal(f.controller.state.nodes.length, 2);
  assert.equal(f.controller.state.lastUpdated, 456);
  assert.equal(f.controller.state.planCached, true);
  assert.equal(f.controller.state.loading, false);
  assert.equal(f.controller.state.notice, "");
  assert.deepEqual(f.requests, []);
  assert.ok(!f.events.includes("sync"));
  assert.ok(!f.events.includes("start"));
});

test("invalid restored session opens home and clears cached account when connecting", async () => {
  const f = fixture({ session: session(), profileId: "owned", selected: "B" }); f.invalid(); await f.controller.restore();
  assert.equal(f.controller.state.user?.id, "test-user");
  assert.deepEqual(f.requests, []);
  await assert.rejects(f.controller.connect());
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
  const defaultPackaged = configuredAccountApi(true, "", { enabled: true, subscriptionUrl: "https://example.invalid/sub" });
  assert.equal(defaultPackaged.api.baseURL, "https://chat.kukuhou.com");
  assert.equal(defaultPackaged.developmentLogin, undefined);
  assert.equal(trustedSubscriptionOrigin(defaultPackaged.api.baseURL, "https://sub.kukuhou.com/s/test", "https://sub.kukuhou.com"), "https://sub.kukuhou.com");
  const packaged = configuredAccountApi(true, "https://example.invalid", { enabled: true, subscriptionUrl: "https://example.invalid/sub" });
  assert.equal(packaged.developmentLogin, undefined); assert.equal(packaged.api.baseURL, "https://example.invalid");
  assert.equal(configuredAccountApi(false, "", { subscriptionUrl: "https://example.invalid/sub" }).developmentLogin, undefined);
  assert.equal(configuredAccountApi(false, "").api.baseURL, "");
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
test("background invalidation stays silent and preserves connection and account cache", async () => {
  const f = fixture(); await f.controller.login("test", "test", true); await f.controller.connect(); f.invalid();
  await f.controller.verify();
  assert.ok(f.controller.state.user); assert.ok(f.saved()); assert.ok(!f.events.includes("stop"));
  assert.equal(f.controller.state.phase, "connected");
  assert.equal(f.controller.state.error, "");
  assert.equal(f.controller.state.notice, "");
});
test("background account outages preserve healthy connections and recover automatically", async () => {
  const f = fixture(); await f.controller.login("test", "test", true); await f.controller.connect(); f.network();
  for (let minute = 0; minute < 5; minute++) await f.controller.verify();
  assert.equal(f.controller.state.phase, "connected");
  assert.equal(f.controller.state.error, "");
  assert.equal(f.controller.state.planCached, true);
  assert.equal(f.controller.state.notice, "");
  assert.ok(!f.events.includes("stop"));
  f.network(false); await f.controller.verify();
  assert.equal(f.controller.state.notice, "");
  assert.equal(f.controller.state.planCached, false);
  assert.equal(f.controller.state.phase, "connected");
});

test("background service errors retain proxy while manual refresh reports failure", async () => {
  for (const status of [429, 500, 503]) {
    const f = fixture(); await f.controller.login("test", "test", true); await f.controller.connect();
    f.serviceStatus(status); await f.controller.verify(true);
    assert.equal(f.controller.state.phase, "connected");
    assert.equal(f.controller.state.error, "");
    assert.equal(f.controller.state.notice, "");
    await assert.rejects(f.controller.refresh());
    assert.equal(f.controller.state.phase, "connected");
    assert.ok(f.controller.state.error);
    assert.ok(!JSON.stringify(f.controller.state).includes("SECRET"));
  }
});

test("background subscription failures keep nodes and use a notice", async () => {
  const f = fixture(); await f.controller.login("test", "test", true); await f.controller.connect();
  f.failSync(); await f.controller.verify(true);
  assert.equal(f.controller.state.phase, "connected");
  assert.equal(f.controller.state.nodes.length, 2);
  assert.equal(f.controller.state.error, "");
  assert.match(f.controller.state.notice, /自动更新失败.*现有节点/);
});

test("background local session expiry stays silent and connected during an account outage", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const f = fixture(); await f.controller.login("test", "test", true); await f.controller.connect();
  f.network(); t.mock.timers.tick(86400_001);
  await f.controller.verify();
  assert.ok(f.controller.state.user);
  assert.equal(f.controller.state.phase, "connected");
  assert.ok(f.saved());
  assert.ok(!f.events.includes("stop"));
  assert.equal(f.controller.state.error, "");
  assert.equal(f.controller.state.notice, "");
});

test("background 403 stays connected while manual validation handles invalidation", async () => {
  const disabled = fixture(); await disabled.controller.login("test", "test", true); await disabled.controller.connect();
  disabled.serviceStatus(403); await disabled.controller.verify(true);
  assert.ok(disabled.controller.state.user);
  assert.equal(disabled.controller.state.phase, "connected");
  assert.equal(disabled.controller.state.error, "");
  assert.equal(disabled.controller.state.notice, "");
  assert.ok(!disabled.events.includes("stop"));
  await assert.rejects(disabled.controller.refresh(), /停用/);
  assert.equal(disabled.controller.state.user, null);
  assert.ok(disabled.events.includes("stop"));
});

test("successfully verified ineligible plans still disconnect", async () => {
  for (const subscriptionStatus of ["expired", "quota_exhausted", "pending"] as const) {
    const f = fixture(); await f.controller.login("test", "test", true); await f.controller.connect();
    f.responseSession({ ...session(), subscriptionStatus });
    await assert.rejects(f.controller.verify());
    assert.equal(f.controller.state.phase, "idle");
    assert.ok(f.events.includes("stop"));
  }
});
test("non-active subscription status prevents new connection", async () => {
  const value = { ...session(), subscriptionStatus: "expired" as const };
  const api = new AccountApi("https://example.invalid", async () => Response.json(value));
  let starts = 0;
  const controller = new CompactController(api, { load: async () => null, save: async () => true, cleanup: async () => {}, read: async () => config(), sync: async () => ({id:"profile",content:config(),updated:1}), start: async () => { starts++; }, stop: async () => {}, select: async () => {}, running: () => false, changed: () => {} });
  await controller.login("test", "test", false); assert.equal(controller.state.user?.id, "test-user"); assert.equal(controller.state.nodes.length, 0); await assert.rejects(controller.connect(), /额度耗尽/); assert.equal(starts, 0);
});

test("plan fields distinguish absent data, unlimited expiry and invalid values", () => {
  const value = parseSession({ ...session(), subscriptionUrl: null, subscriptionStatus: "expired", usedBytes: 120, quotaBytes: 100, usageMonth: "2026-10", subscriptionExpiresAt: "2026-10-01T00:00:00Z" });
  assert.equal(value.usedBytes, 120);
  assert.equal(value.subscriptionUrl, null);
  assert.equal(planDisplay(value, Date.parse("2026-10-12T00:00:00Z")).expiryStatus, "已到期");
  assert.equal(planDisplay(value).usageStatus, "额度耗尽");
  assert.equal(planDisplay().expiry, "暂无数据");
  assert.equal(planDisplay({ subscriptionExpiresAt: null }).expiry, "长期有效");
  assert.equal(planDisplay({ usedBytes: 0, quotaBytes: 0 }).usageStatus, "额度耗尽");
  assert.equal(planDisplay({ usedBytes: 90, quotaBytes: 100 }).usageStatus, "即将用尽");
  for (const fields of [{ usedBytes: -1 }, { quotaBytes: Infinity }, { usedBytes: "10" }, { usageMonth: "2026-13" }, { subscriptionExpiresAt: 123 }, { subscriptionExpiresAt: "invalid" }]) assert.throws(() => parseSession({ ...session(), ...fields }));
});

test("cached plan survives offline restore and clears on logout", async () => {
  const cached = { ...session(), usedBytes: 42, quotaBytes: 100, usageMonth: "2026-09", subscriptionExpiresAt: null };
  const f = fixture({ session: cached, selected: "A", profileId: "managed-profile" });
  f.network(); await f.controller.restore();
  assert.equal(f.controller.state.plan?.usedBytes, 42);
  assert.equal(f.controller.state.planCached, true);
  await f.controller.logout();
  assert.equal(f.controller.state.plan, undefined);
});

test("verification replaces cached plan and removes fields absent on older server", async () => {
  const f = fixture({ session: { ...session(), usedBytes: 42, quotaBytes: 100, usageMonth: "2026-09" }, selected: "A" });
  await f.controller.restore(); await f.controller.verify();
  assert.equal(f.controller.state.plan?.usedBytes, undefined);
  assert.equal(f.controller.state.planCached, false);
});

test("minute verification updates month and usage, network failure retains it", async () => {
  const f = fixture(); await f.controller.login("test", "test", false);
  f.responseSession({ ...session(), usedBytes: 75, quotaBytes: 100, usageMonth: "2026-11", subscriptionExpiresAt: null });
  await f.controller.verify();
  assert.equal(f.controller.state.plan?.usageMonth, "2026-11");
  assert.equal(f.controller.state.plan?.usedBytes, 75);
  f.network(); await f.controller.verify();
  assert.equal(f.controller.state.plan?.usedBytes, 75);
  assert.equal(f.controller.state.planCached, true);
});

test("expired accounts with null subscription retain plan but cannot connect or download", async () => {
  const f = fixture();
  f.responseSession({ ...session(), subscriptionStatus: "expired", subscriptionUrl: null, usedBytes: 35, quotaBytes: 100, subscriptionExpiresAt: "2020-01-01T00:00:00Z" });
  await f.controller.login("test", "test", true);
  assert.equal(f.controller.state.plan?.usedBytes, 35);
  assert.ok(f.controller.state.user);
  assert.equal(f.events.includes("sync"), false);
  await assert.rejects(f.controller.connect());
});
