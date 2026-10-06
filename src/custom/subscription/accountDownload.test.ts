import assert from "node:assert/strict";
import test from "node:test";
import { fetchAccountSubscription } from "./accountDownload";
const auth = { origin: "https://example.invalid", headers: { Authorization: "Bearer synthetic", "X-Client-Device-Id": "synthetic-device" }, rejected: (status: number) => new Error(`Rejected ${status}`) };
test("account subscription sends credentials only to trusted HTTPS origin and refuses redirects", async () => {
  let calls = 0;
  const request: typeof fetch = async (_url, init) => {
    calls++; assert.equal(init?.redirect, "error"); assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer synthetic"); assert.equal(new Headers(init?.headers).get("X-Client-Device-Id"), "synthetic-device");
    return new Response('{"outbounds":[{"type":"direct","tag":"direct"}]}');
  };
  await fetchAccountSubscription("https://example.invalid/s/token", auth, "test", request);
  for (const url of ["https://other.invalid/s/token", "http://example.invalid/s/token", "https://user:pass@example.invalid/s/token"]) await assert.rejects(fetchAccountSubscription(url, auth, "test", request));
  assert.equal(calls, 1);
  for (const status of [302, 401, 403, 503]) await assert.rejects(fetchAccountSubscription("https://example.invalid/s/token", auth, "test", async () => new Response("SECRET", { status })), (error: unknown) => error instanceof Error && error.message === `Rejected ${status}`);
});
test("account subscription limits response sizes before normalization", async () => {
  await assert.rejects(fetchAccountSubscription("https://example.invalid/s/token", auth, "test", async () => new Response("x", { headers: {"content-length": String(16 * 1024 * 1024 + 1)} })), /too large/);
  await assert.rejects(fetchAccountSubscription("https://example.invalid/s/token", auth, "test", async () => new Response(new Uint8Array(16 * 1024 * 1024 + 1))), /too large/);
});
