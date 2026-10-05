
export interface AccountSubscriptionAuth {
  headers: Record<string, string>;
  origin: string;
  rejected(status: number): Error;
}

// Account credentials are never sent through the generic remote-profile downloader.
export async function fetchAccountSubscription(url: string, auth: AccountSubscriptionAuth, userAgent: string, request: typeof fetch = fetch): Promise<string> {
  const target = new URL(url);
  if (target.protocol !== "https:" || target.origin !== auth.origin || target.username || target.password) throw new Error("Untrusted account subscription origin");
  const response = await request(target, { headers: { "User-Agent": userAgent, ...auth.headers }, redirect: "error", signal: AbortSignal.timeout(15_000) });
  if (response.status !== 200) { await response.body?.cancel(); throw auth.rejected(response.status); }
  const maximum = 16 * 1024 * 1024;
  if (Number(response.headers.get("content-length")) > maximum) { await response.body?.cancel(); throw new Error("Account subscription too large"); }
  const reader = response.body?.getReader(); if (!reader) throw new Error("Empty account subscription");
  const chunks: Buffer[] = []; let size = 0;
  for (;;) {
    const result = await reader.read(); if (result.done) break;
    size += result.value.byteLength;
    if (size > maximum) { await reader.cancel(); throw new Error("Account subscription too large"); }
    chunks.push(Buffer.from(result.value));
  }
  return Buffer.concat(chunks, size).toString("utf8");
}
