import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEtsyMcpServer } from "../../src/index.js";
import { connectClient, textOf } from "../helpers/mcp.js";

const TOKEN_URL = "https://api.etsy.com/v3/public/oauth/token";
const API = "https://openapi.etsy.com/v3/application";

type Reply = { status: number; body: unknown; delayMs?: number };

/** Stubs fetch by URL; anything unrouted fails loudly so a wrong request can't pass unnoticed. */
function stubFetch(routes: Record<string, Reply>) {
  const calls: Array<{ url: string; method: string }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const reply = routes[url];
      calls.push({ url, method: init?.method ?? "GET" });
      if (!reply) throw new Error(`unrouted fetch: ${url}`);
      if (reply.delayMs) await new Promise((resolve) => setTimeout(resolve, reply.delayMs));
      return {
        ok: reply.status >= 200 && reply.status < 300,
        status: reply.status,
        headers: new Headers(),
        json: async () => reply.body,
        text: async () => JSON.stringify(reply.body),
      };
    })
  );
  return {
    count: (url: string) => calls.filter((call) => call.url === url).length,
    methods: (url: string) => calls.filter((call) => call.url === url).map((call) => call.method),
  };
}

describe("server composed end to end (real auth manager, client and tools; only fetch is stubbed)", () => {
  let dir: string;
  let tokenStorePath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "etsy-mcp-composed-"));
    tokenStorePath = join(dir, "tokens.json");
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await rm(dir, { recursive: true, force: true });
  });

  function connect() {
    return connectClient(createEtsyMcpServer({ apiKey: "test-key", sharedSecret: "test-secret", tokenStorePath }));
  }

  async function writeTokens(tokens: { access_token: string; refresh_token: string; expires_at: number }) {
    await writeFile(tokenStorePath, JSON.stringify(tokens), "utf-8");
  }

  it("tells Claude to call authenticate when never signed in, after a single /users/me request", async () => {
    const etsy = stubFetch({ [`${API}/users/me`]: { status: 401, body: { error: "Unauthorized" } } });
    const client = await connect();

    const result = await client.callTool({ name: "get_shop", arguments: {} });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("authenticate");
    expect(etsy.count(`${API}/users/me`)).toBe(1);
    expect(etsy.count(TOKEN_URL)).toBe(0);
  });

  it("refreshes an expired token once and looks the shop up once for three parallel calls", async () => {
    await writeTokens({ access_token: "old", refresh_token: "r1", expires_at: Date.now() - 60_000 });
    const etsy = stubFetch({
      [TOKEN_URL]: { status: 200, body: { access_token: "new", refresh_token: "r2", expires_in: 3600 } },
      [`${API}/users/me`]: { status: 200, body: { user_id: 1, shop_id: 777 } },
      [`${API}/shops/777/receipts?limit=25&offset=0`]: { status: 200, body: { count: 0, results: [] } },
    });
    const client = await connect();

    const results = await Promise.all([1, 2, 3].map(() => client.callTool({ name: "get_shop_receipts", arguments: {} })));

    for (const result of results) {
      expect(result.isError, textOf(result)).toBeFalsy();
    }
    expect(etsy.count(TOKEN_URL)).toBe(1);
    expect(etsy.methods(TOKEN_URL)).toEqual(["POST"]);
    expect(etsy.count(`${API}/users/me`)).toBe(1);
    expect(etsy.count(`${API}/shops/777/receipts?limit=25&offset=0`)).toBe(3);
  });

  it("shares one in-flight refresh across parallel calls that already know their shop", async () => {
    await writeTokens({ access_token: "old", refresh_token: "r1", expires_at: Date.now() - 60_000 });
    const etsy = stubFetch({
      // Slower than the client's request spacing, so the later calls arrive while the refresh is still running.
      [TOKEN_URL]: { status: 200, delayMs: 400, body: { access_token: "new", refresh_token: "r2", expires_in: 3600 } },
      [`${API}/shops/5/receipts?limit=25&offset=0`]: { status: 200, body: { count: 0, results: [] } },
    });
    const client = await connect();

    const results = await Promise.all([1, 2, 3].map(() => client.callTool({ name: "get_shop_receipts", arguments: { shop_id: 5 } })));

    for (const result of results) {
      expect(result.isError, textOf(result)).toBeFalsy();
    }
    expect(etsy.count(TOKEN_URL)).toBe(1);
    expect(etsy.count(`${API}/shops/5/receipts?limit=25&offset=0`)).toBe(3);
  });
});
