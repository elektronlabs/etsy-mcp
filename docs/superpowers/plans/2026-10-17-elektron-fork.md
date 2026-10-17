# Etsy MCP Elektron Fork Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the upstream `aserper/etsy-mcp` fork into a hardened 33-tool stdio MCP server for one Etsy shop, run locally by Claude Code and Claude Desktop on Mothership.

**Architecture:** Keep upstream's shape (`src/auth`, `src/client`, `src/tools/*` registering on one `McpServer`). Add a `ShopContext` that resolves a default `shop_id` from `/users/me`, shared annotation constants, a stats module, and an env loader. Fix the OAuth callback, scopes, retry policy, auth error surfacing, and upload path guard in place.

**Tech Stack:** Node ≥ 20, TypeScript 6 (strict, ESM, `Node16` modules), `@modelcontextprotocol/sdk` 1.29, `zod` 4, `dotenv` 17, `open` 11, `vitest` 4.

**Spec:** `docs/superpowers/specs/2026-10-17-elektron-fork-design.md`

## Global Constraints

- Node `>=20.0.0`. ESM with `Node16` resolution: every relative import in `src/` ends in `.js`.
- No new runtime dependencies. No new dev dependencies.
- OAuth scopes are exactly `listings_r listings_w shops_r transactions_r transactions_w`.
- Redirect URI is exactly `http://localhost:3003/oauth/redirect` (port overridable by `ETSY_REDIRECT_PORT`); the callback server binds `127.0.0.1`.
- Keys load from `~/.etsy-mcp/.env` (never from the project folder — `D:\PROJECTS` is mirrored to the VPS by Syncthing, `.env` included). Real env vars win.
- Nothing may write to stdout except the MCP stdio transport. Logs go to `console.error`. dotenv always runs with `quiet: true`.
- Final tool count is 33: 25 read tools, 8 write tools (names listed in Task 2 and Task 4).
- `x-api-key` header stays `keystring:shared_secret`.
- Work on branch `feat/elektron-fork`. Do not push, open a PR, or call any live Etsy write endpoint without Devin's explicit OK. PR base is `main` on `elektronlabs/etsy-mcp`, never the upstream repo.
- Every commit ends with the trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Shell is Git Bash on Windows. Run commands from `D:/PROJECTS/etsy-mcp`.
- Install with `npm install` (upstream's lockfile is out of sync, so `npm ci` fails until Task 1 commits the synced lockfile).

## File Map

| File | Status | Responsibility |
|---|---|---|
| `src/client/shop-context.ts` | create | Resolve `shop_id`: explicit value, else the seller's own shop via `/users/me`, cached |
| `src/tools/annotations.ts` | create | `READ`, `WRITE_ADDITIVE`, `WRITE_DESTRUCTIVE` tool annotation constants |
| `src/tools/args.ts` | create | Shared `shopIdArg` zod schema |
| `src/tools/stats.ts` | create | `get_sales_summary` + `buildSalesSummary`, `dayRangeUtc` |
| `src/utils/money.ts` | create | Etsy `Money` → hundredths → decimal |
| `src/env.ts` | create | `etsyEnvPath`, `loadEnvFile` (quiet dotenv from `~/.etsy-mcp/.env`) |
| `scripts/smoke-stdio.mjs` | create | Launch built server over stdio from another cwd, assert 33 tools |
| `tests/helpers/mcp.ts` | create | In-memory MCP client for tool-level tests |
| `src/tools/{listings,shop,orders,transactions,reviews,taxonomy,images,inventory,payments}.ts` | modify | Trim, move, optional `shop_id`, annotations |
| `src/tools/{users,shipping,return-policies}.ts` | delete | Removed or moved tools |
| `src/client/etsy-client.ts` | modify | Retry policy, auth error passthrough |
| `src/auth/oauth.ts` | modify | Fixed redirect, loopback bind, stray-request tolerance, typed refresh error |
| `src/auth/auth-manager.ts` | modify | Surface auth failures as `EtsyAuthError` |
| `src/utils/errors.ts` | modify | Add `EtsyAuthError`, `TokenRefreshError` |
| `src/index.ts` | modify | Wiring, scopes, redirect port, env loading |
| `Dockerfile`, `.github/workflows/docker-publish.yml` | delete | Not used (local stdio only) |
| `README.md`, `.env.example`, `package.json`, `tests/integration/ping.test.ts` | modify | Fork docs, version, ping auth header |

---

### Task 1: Sync lockfile and add ShopContext

**Files:**
- Modify: `package-lock.json` (via `npm install`)
- Create: `src/client/shop-context.ts`
- Test: `tests/unit/client/shop-context.test.ts`

**Interfaces:**
- Produces: `class ShopContext { constructor(client: Pick<EtsyClient, "get">); resolve(shopId?: number): Promise<number> }`

- [ ] **Step 1: Sync the lockfile and confirm the baseline**

Run:
```bash
cd D:/PROJECTS/etsy-mcp && npm install --no-audit --no-fund && npm run lint && npm test
```
Expected: lint clean; `Test Files 19 passed (19)`, `Tests 45 passed (45)`. `git status` shows only `package-lock.json` modified.

- [ ] **Step 2: Commit the lockfile**

```bash
git add package-lock.json
git commit -m "chore: sync package-lock.json with package.json" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 3: Write the failing test**

Create `tests/unit/client/shop-context.test.ts`:
```ts
import { describe, it, expect, vi } from "vitest";
import { ShopContext } from "../../../src/client/shop-context.js";
import type { EtsyClient } from "../../../src/client/etsy-client.js";

describe("ShopContext", () => {
  it("returns an explicit shop_id without calling Etsy", async () => {
    const get = vi.fn();
    const shop = new ShopContext({ get } as unknown as EtsyClient);
    await expect(shop.resolve(42)).resolves.toBe(42);
    expect(get).not.toHaveBeenCalled();
  });

  it("looks up the seller's own shop once and caches it", async () => {
    const get = vi.fn().mockResolvedValue({ user_id: 1, shop_id: 777 });
    const shop = new ShopContext({ get } as unknown as EtsyClient);
    const both = await Promise.all([shop.resolve(), shop.resolve()]);
    await expect(shop.resolve()).resolves.toBe(777);
    expect(both).toEqual([777, 777]);
    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith("/users/me");
  });

  it("errors clearly when the account has no shop, then retries on the next call", async () => {
    const get = vi
      .fn()
      .mockResolvedValueOnce({ user_id: 1 })
      .mockResolvedValueOnce({ user_id: 1, shop_id: 5 });
    const shop = new ShopContext({ get } as unknown as EtsyClient);
    await expect(shop.resolve()).rejects.toThrow("no shop");
    await expect(shop.resolve()).resolves.toBe(5);
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `npx vitest run tests/unit/client/shop-context.test.ts`
Expected: FAIL — cannot resolve `../../../src/client/shop-context.js`.

- [ ] **Step 5: Write the implementation**

Create `src/client/shop-context.ts`:
```ts
import type { EtsyClient } from "./etsy-client.js";

/** Resolves which shop a tool acts on: an explicit shop_id, else the signed-in seller's own shop (looked up once). */
export class ShopContext {
  private pending: Promise<number> | null = null;

  constructor(private client: Pick<EtsyClient, "get">) {}

  async resolve(shopId?: number): Promise<number> {
    if (shopId !== undefined) return shopId;
    if (!this.pending) {
      this.pending = this.lookup().catch((err) => {
        this.pending = null;
        throw err;
      });
    }
    return this.pending;
  }

  private async lookup(): Promise<number> {
    const me = await this.client.get<{ user_id: number; shop_id?: number }>("/users/me");
    if (!me.shop_id) {
      throw new Error("This Etsy account has no shop. Pass shop_id explicitly.");
    }
    return me.shop_id;
  }
}
```

- [ ] **Step 6: Run tests and type check**

Run: `npx vitest run tests/unit/client/shop-context.test.ts && npm run lint`
Expected: 3 passed; lint clean.

- [ ] **Step 7: Commit**

```bash
git add src/client/shop-context.ts tests/unit/client/shop-context.test.ts
git commit -m "feat: add ShopContext to default shop_id to the seller's shop" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Reshape the tool surface (trim, move, default shop, annotations)

**Files:**
- Create: `src/tools/annotations.ts`, `src/tools/args.ts`, `tests/helpers/mcp.ts`, `tests/unit/registry.test.ts`
- Modify (full rewrite): `src/tools/listings.ts`, `src/tools/shop.ts`, `src/tools/orders.ts`, `src/tools/transactions.ts`, `src/tools/reviews.ts`, `src/tools/taxonomy.ts`, `src/tools/images.ts`, `src/tools/inventory.ts`, `src/tools/payments.ts`
- Modify: `src/index.ts`
- Delete: `src/tools/users.ts`, `src/tools/shipping.ts`, `src/tools/return-policies.ts`, `tests/unit/tools/users.test.ts`, `tests/unit/tools/shipping.test.ts`, `tests/unit/tools/return-policies.test.ts`

**Interfaces:**
- Consumes: `ShopContext.resolve(shopId?: number): Promise<number>` (Task 1)
- Produces:
  - `READ`, `WRITE_ADDITIVE`, `WRITE_DESTRUCTIVE: ToolAnnotations` from `src/tools/annotations.ts`
  - `shopIdArg` (zod optional number) from `src/tools/args.ts`
  - `connectClient(server: McpServer): Promise<Client>` and `textOf(result: unknown): string` from `tests/helpers/mcp.ts`
  - Register signatures: `registerListingsTools(server, client, shop)`, `registerShopTools(server, client, shop)`, `registerOrdersTools(server, client, shop)`, `registerTransactionsTools(server, client, shop)`, `registerReviewsTools(server, client, shop)`, `registerImagesTools(server, client, shop)`, `registerPaymentsTools(server, client, shop)`, `registerTaxonomyTools(server, client)`, `registerInventoryTools(server, client)`
  - `READS`, `ADDITIVE_WRITES`, `DESTRUCTIVE_WRITES` arrays in `tests/unit/registry.test.ts` (Tasks 3 and 4 append to `READS`)

- [ ] **Step 1: Add the test helper**

Create `tests/helpers/mcp.ts`:
```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/** Connects a real MCP client to the server in-process, so tests exercise tools the way Claude calls them. */
export async function connectClient(server: McpServer): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(clientTransport);
  return client;
}

export function textOf(result: unknown): string {
  const content = (result as { content: Array<{ type: string; text?: string }> }).content;
  return content.map((part) => part.text ?? "").join("");
}
```

- [ ] **Step 2: Write the failing registry test**

Create `tests/unit/registry.test.ts`:
```ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEtsyMcpServer } from "../../src/index.js";
import { connectClient } from "../helpers/mcp.js";

const READS = [
  "authenticate", "find_shops", "get_buyer_taxonomy", "get_ledger_entries", "get_listing",
  "get_listing_images", "get_listing_inventory", "get_listings_by_shop", "get_me", "get_payments",
  "get_receipt", "get_reviews_by_listing", "get_reviews_by_shop", "get_shipping_carriers",
  "get_shipping_profiles", "get_shop", "get_shop_receipts", "get_shop_sections",
  "get_taxonomy_properties", "get_transaction", "get_transactions_by_receipt",
  "get_transactions_by_shop", "search_listings",
];
const ADDITIVE_WRITES = ["create_draft_listing", "create_shipment", "upload_listing_image", "upload_listing_video"];
const DESTRUCTIVE_WRITES = ["delete_listing_image", "update_listing", "update_listing_inventory", "update_receipt"];

function makeServer() {
  return createEtsyMcpServer({
    apiKey: "test-key",
    sharedSecret: "test-secret",
    tokenStorePath: join(tmpdir(), `etsy-mcp-no-tokens-${process.pid}.json`),
  });
}

async function listTools() {
  const client = await connectClient(makeServer());
  return (await client.listTools()).tools;
}

function stubEtsy(shopId: number) {
  const fetchMock = vi.fn(async (url: string) => ({
    ok: true,
    status: 200,
    json: async () => (url.endsWith("/users/me") ? { user_id: 1, shop_id: shopId } : { count: 0, results: [] }),
  }));
  vi.stubGlobal("fetch", fetchMock);
  return () => fetchMock.mock.calls.map(([url]) => new URL(url).pathname);
}

describe("tool registry", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("registers exactly the expected tools", async () => {
    const names = (await listTools()).map((tool) => tool.name).sort();
    expect(names).toEqual([...READS, ...ADDITIVE_WRITES, ...DESTRUCTIVE_WRITES].sort());
  });

  it("marks every read tool read-only", async () => {
    for (const tool of (await listTools()).filter((t) => READS.includes(t.name))) {
      expect(tool.annotations, tool.name).toMatchObject({ readOnlyHint: true, openWorldHint: true });
    }
  });

  it("marks additive writes as non-destructive writes", async () => {
    for (const tool of (await listTools()).filter((t) => ADDITIVE_WRITES.includes(t.name))) {
      expect(tool.annotations, tool.name).toMatchObject({ readOnlyHint: false, destructiveHint: false, openWorldHint: true });
    }
  });

  it("marks destructive writes as destructive", async () => {
    for (const tool of (await listTools()).filter((t) => DESTRUCTIVE_WRITES.includes(t.name))) {
      expect(tool.annotations, tool.name).toMatchObject({ readOnlyHint: false, destructiveHint: true, openWorldHint: true });
    }
  });

  it("defaults shop_id to the signed-in seller's shop, looked up once", async () => {
    const paths = stubEtsy(777);
    const client = await connectClient(makeServer());
    await client.callTool({ name: "get_shop", arguments: {} });
    await client.callTool({ name: "get_shop_receipts", arguments: {} });
    expect(paths()).toEqual([
      "/v3/application/users/me",
      "/v3/application/shops/777",
      "/v3/application/shops/777/receipts",
    ]);
  });

  it("uses an explicit shop_id without looking anything up", async () => {
    const paths = stubEtsy(777);
    const client = await connectClient(makeServer());
    await client.callTool({ name: "get_shop", arguments: { shop_id: 5 } });
    expect(paths()).toEqual(["/v3/application/shops/5"]);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/unit/registry.test.ts`
Expected: FAIL — "registers exactly the expected tools" lists 41 names including `update_shop`, `delete_listing`; annotations are `undefined`; `get_shop` rejects the missing `shop_id`.

- [ ] **Step 4: Add the shared annotation and argument modules**

Create `src/tools/annotations.ts`:
```ts
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";

/** Reads from Etsy; changes nothing. */
export const READ: ToolAnnotations = { readOnlyHint: true, openWorldHint: true };

/** Adds something new to the shop: a draft listing, a shipment, a photo. */
export const WRITE_ADDITIVE: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, openWorldHint: true };

/** Changes or removes existing shop data. */
export const WRITE_DESTRUCTIVE: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, openWorldHint: true };
```

Create `src/tools/args.ts`:
```ts
import { z } from "zod";

/** Optional on every shop-scoped tool: omitted means the signed-in seller's own shop. */
export const shopIdArg = z.number().optional().describe("Shop ID (defaults to your shop)");
```

- [ ] **Step 5: Rewrite `src/tools/listings.ts`** (drops `delete_listing`)

```ts
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { EtsyClient } from "../client/etsy-client.js";
import type { ShopContext } from "../client/shop-context.js";
import { paginationParams, formatPaginatedResponse } from "../utils/pagination.js";
import { READ, WRITE_ADDITIVE, WRITE_DESTRUCTIVE } from "./annotations.js";
import { shopIdArg } from "./args.js";

export function registerListingsTools(server: McpServer, client: EtsyClient, shop: ShopContext): void {
  server.registerTool(
    "search_listings",
    {
      description: "Search active Etsy listings with keywords and filters",
      inputSchema: {
        keywords: z.string().optional().describe("Search keywords"),
        taxonomy_id: z.number().optional().describe("Filter by taxonomy/category ID"),
        min_price: z.number().optional().describe("Minimum price in USD"),
        max_price: z.number().optional().describe("Maximum price in USD"),
        sort_on: z.enum(["created", "price", "updated", "score"]).optional().describe("Sort field"),
        sort_order: z.enum(["asc", "desc"]).optional().describe("Sort direction"),
        limit: z.number().optional().describe("Results per page (max 100)"),
        offset: z.number().optional().describe("Offset for pagination"),
      },
      annotations: READ,
    },
    async (args) => {
      const params: Record<string, string> = {
        ...paginationParams({ limit: args.limit, offset: args.offset }),
      };
      if (args.keywords) params.keywords = args.keywords;
      if (args.taxonomy_id) params.taxonomy_id = String(args.taxonomy_id);
      if (args.min_price) params.min_price = String(args.min_price);
      if (args.max_price) params.max_price = String(args.max_price);
      if (args.sort_on) params.sort_on = args.sort_on;
      if (args.sort_order) params.sort_order = args.sort_order;

      const data = await client.get<{ count: number; results: unknown[] }>("/listings/active", params);
      return {
        content: [{ type: "text" as const, text: formatPaginatedResponse(data, args.limit ?? 25, args.offset ?? 0) }],
      };
    }
  );

  server.registerTool(
    "get_listing",
    {
      description: "Get details of a specific Etsy listing",
      inputSchema: {
        listing_id: z.number().describe("The listing ID"),
        includes: z.array(z.enum(["images", "shop", "user", "translations", "inventory"])).optional().describe("Related resources to include"),
      },
      annotations: READ,
    },
    async (args) => {
      const params: Record<string, string> = {};
      if (args.includes?.length) params.includes = args.includes.join(",");
      const data = await client.get(`/listings/${args.listing_id}`, params);
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.registerTool(
    "create_draft_listing",
    {
      description: "Create a new draft listing in a shop",
      inputSchema: {
        shop_id: shopIdArg,
        title: z.string().describe("Listing title (max 140 chars)"),
        description: z.string().describe("Listing description"),
        price: z.number().describe("Price in shop's currency"),
        quantity: z.number().describe("Available quantity"),
        taxonomy_id: z.number().describe("Taxonomy/category ID"),
        who_made: z.enum(["i_did", "someone_else", "collective"]).describe("Who made the item"),
        when_made: z.enum(["made_to_order", "2020_2024", "2010_2019", "2005_2009", "before_2005", "2000_2004", "1990s", "1980s", "1970s", "1960s", "1950s", "1940s", "1930s", "1920s", "1910s", "1900s", "1800s", "1700s", "before_1700"]).describe("When it was made"),
        is_supply: z.boolean().describe("Is this a craft supply?"),
        shipping_profile_id: z.number().optional().describe("Shipping profile ID"),
        tags: z.array(z.string()).optional().describe("Tags (max 13)"),
        materials: z.array(z.string()).optional().describe("Materials list"),
        shop_section_id: z.number().optional().describe("Shop section ID"),
        is_customizable: z.boolean().optional().describe("Can be personalized"),
        is_digital: z.boolean().optional().describe("Digital download"),
      },
      annotations: WRITE_ADDITIVE,
    },
    async (args) => {
      const { shop_id, ...body } = args;
      const shopId = await shop.resolve(shop_id);
      const data = await client.post(`/shops/${shopId}/listings`, body);
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.registerTool(
    "update_listing",
    {
      description: "Update an existing listing. Set state to \"inactive\" to take it off sale.",
      inputSchema: {
        shop_id: shopIdArg,
        listing_id: z.number().describe("The listing ID"),
        title: z.string().optional().describe("Listing title"),
        description: z.string().optional().describe("Listing description"),
        price: z.number().optional().describe("Price"),
        quantity: z.number().optional().describe("Quantity"),
        tags: z.array(z.string()).optional().describe("Tags"),
        materials: z.array(z.string()).optional().describe("Materials"),
        state: z.enum(["active", "inactive", "draft"]).optional().describe("Listing state"),
        taxonomy_id: z.number().optional().describe("Taxonomy ID"),
      },
      annotations: WRITE_DESTRUCTIVE,
    },
    async (args) => {
      const { shop_id, listing_id, ...body } = args;
      const shopId = await shop.resolve(shop_id);
      const data = await client.patch(`/shops/${shopId}/listings/${listing_id}`, body);
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.registerTool(
    "get_listings_by_shop",
    {
      description: "Get all listings for a shop, filterable by state",
      inputSchema: {
        shop_id: shopIdArg,
        state: z.enum(["active", "inactive", "draft", "expired", "sold_out"]).optional().describe("Filter by listing state"),
        limit: z.number().optional().describe("Results per page"),
        offset: z.number().optional().describe("Offset for pagination"),
      },
      annotations: READ,
    },
    async (args) => {
      const shopId = await shop.resolve(args.shop_id);
      const params: Record<string, string> = { ...paginationParams({ limit: args.limit, offset: args.offset }) };
      if (args.state) params.state = args.state;
      const data = await client.get<{ count: number; results: unknown[] }>(`/shops/${shopId}/listings`, params);
      return { content: [{ type: "text" as const, text: formatPaginatedResponse(data, args.limit ?? 25, args.offset ?? 0) }] };
    }
  );
}
```

- [ ] **Step 6: Rewrite `src/tools/shop.ts`** (drops `update_shop`, `manage_shop_sections`; gains `get_me` and `get_shipping_profiles`)

```ts
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { EtsyClient } from "../client/etsy-client.js";
import type { ShopContext } from "../client/shop-context.js";
import { paginationParams, formatPaginatedResponse } from "../utils/pagination.js";
import { READ } from "./annotations.js";
import { shopIdArg } from "./args.js";

export function registerShopTools(server: McpServer, client: EtsyClient, shop: ShopContext): void {
  server.registerTool("get_me", {
    description: "Get the signed-in Etsy user (user_id and shop_id)",
    annotations: READ,
  }, async () => {
    const data = await client.get("/users/me");
    return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
  });

  server.registerTool("get_shop", {
    description: "Get details of an Etsy shop (defaults to your shop)",
    inputSchema: { shop_id: shopIdArg },
    annotations: READ,
  }, async (args) => {
    const shopId = await shop.resolve(args.shop_id);
    const data = await client.get(`/shops/${shopId}`);
    return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
  });

  server.registerTool("find_shops", {
    description: "Search for Etsy shops by name",
    inputSchema: {
      shop_name: z.string().describe("Shop name to search for"),
      limit: z.number().optional().describe("Results per page"),
      offset: z.number().optional().describe("Offset for pagination"),
    },
    annotations: READ,
  }, async (args) => {
    const params: Record<string, string> = { shop_name: args.shop_name, ...paginationParams({ limit: args.limit, offset: args.offset }) };
    const data = await client.get<{ count: number; results: unknown[] }>("/shops", params);
    return { content: [{ type: "text" as const, text: formatPaginatedResponse(data, args.limit ?? 25, args.offset ?? 0) }] };
  });

  server.registerTool("get_shop_sections", {
    description: "Get all sections of a shop",
    inputSchema: { shop_id: shopIdArg },
    annotations: READ,
  }, async (args) => {
    const shopId = await shop.resolve(args.shop_id);
    const data = await client.get(`/shops/${shopId}/sections`);
    return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
  });

  server.registerTool("get_shipping_profiles", {
    description: "List all shipping profiles for a shop",
    inputSchema: { shop_id: shopIdArg },
    annotations: READ,
  }, async (args) => {
    const shopId = await shop.resolve(args.shop_id);
    const data = await client.get(`/shops/${shopId}/shipping-profiles`);
    return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
  });
}
```

- [ ] **Step 7: Rewrite `src/tools/orders.ts`** (gains `get_shipping_carriers`)

```ts
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { EtsyClient } from "../client/etsy-client.js";
import type { ShopContext } from "../client/shop-context.js";
import { paginationParams, formatPaginatedResponse } from "../utils/pagination.js";
import { READ, WRITE_ADDITIVE, WRITE_DESTRUCTIVE } from "./annotations.js";
import { shopIdArg } from "./args.js";

export function registerOrdersTools(server: McpServer, client: EtsyClient, shop: ShopContext): void {
  server.registerTool("get_shop_receipts", {
    description: "List orders/receipts for a shop with optional filters",
    inputSchema: {
      shop_id: shopIdArg,
      min_created: z.number().optional().describe("Minimum creation timestamp (epoch seconds)"),
      max_created: z.number().optional().describe("Maximum creation timestamp (epoch seconds)"),
      was_paid: z.boolean().optional().describe("Filter by payment status"),
      was_shipped: z.boolean().optional().describe("Filter by shipment status"),
      limit: z.number().optional().describe("Results per page"),
      offset: z.number().optional().describe("Offset for pagination"),
    },
    annotations: READ,
  }, async (args) => {
    const shopId = await shop.resolve(args.shop_id);
    const params: Record<string, string> = { ...paginationParams({ limit: args.limit, offset: args.offset }) };
    if (args.min_created) params.min_created = String(args.min_created);
    if (args.max_created) params.max_created = String(args.max_created);
    if (args.was_paid !== undefined) params.was_paid = String(args.was_paid);
    if (args.was_shipped !== undefined) params.was_shipped = String(args.was_shipped);
    const data = await client.get<{ count: number; results: unknown[] }>(`/shops/${shopId}/receipts`, params);
    return { content: [{ type: "text" as const, text: formatPaginatedResponse(data, args.limit ?? 25, args.offset ?? 0) }] };
  });

  server.registerTool("get_receipt", {
    description: "Get a specific receipt/order by ID",
    inputSchema: {
      shop_id: shopIdArg,
      receipt_id: z.number().describe("The receipt ID"),
    },
    annotations: READ,
  }, async (args) => {
    const shopId = await shop.resolve(args.shop_id);
    const data = await client.get(`/shops/${shopId}/receipts/${args.receipt_id}`);
    return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
  });

  server.registerTool("update_receipt", {
    description: "Update a receipt (e.g., mark as shipped)",
    inputSchema: {
      shop_id: shopIdArg,
      receipt_id: z.number().describe("The receipt ID"),
      was_shipped: z.boolean().optional().describe("Mark as shipped"),
      was_paid: z.boolean().optional().describe("Mark as paid"),
    },
    annotations: WRITE_DESTRUCTIVE,
  }, async (args) => {
    const { shop_id, receipt_id, ...body } = args;
    const shopId = await shop.resolve(shop_id);
    const data = await client.put(`/shops/${shopId}/receipts/${receipt_id}`, body);
    return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
  });

  server.registerTool("create_shipment", {
    description: "Create a shipment with tracking for a receipt",
    inputSchema: {
      shop_id: shopIdArg,
      receipt_id: z.number().describe("The receipt ID"),
      tracking_code: z.string().optional().describe("Tracking number"),
      carrier_name: z.string().optional().describe("Carrier name (e.g., 'usps', 'fedex')"),
      send_bcc: z.boolean().optional().describe("Send BCC to seller"),
    },
    annotations: WRITE_ADDITIVE,
  }, async (args) => {
    const { shop_id, receipt_id, ...body } = args;
    const shopId = await shop.resolve(shop_id);
    const data = await client.post(`/shops/${shopId}/receipts/${receipt_id}/tracking`, body);
    return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
  });

  server.registerTool("get_shipping_carriers", {
    description: "List available shipping carriers by origin country",
    inputSchema: { origin_country_iso: z.string().describe("Origin country ISO code (e.g., 'US')") },
    annotations: READ,
  }, async (args) => {
    const data = await client.get("/shipping-carriers", { origin_country_iso: args.origin_country_iso });
    return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
  });
}
```

- [ ] **Step 8: Rewrite `src/tools/transactions.ts`**

```ts
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { EtsyClient } from "../client/etsy-client.js";
import type { ShopContext } from "../client/shop-context.js";
import { paginationParams, formatPaginatedResponse } from "../utils/pagination.js";
import { READ } from "./annotations.js";
import { shopIdArg } from "./args.js";

export function registerTransactionsTools(server: McpServer, client: EtsyClient, shop: ShopContext): void {
  server.registerTool("get_transactions_by_shop", {
    description: "Get all transactions for a shop",
    inputSchema: {
      shop_id: shopIdArg,
      limit: z.number().optional().describe("Results per page"),
      offset: z.number().optional().describe("Offset for pagination"),
    },
    annotations: READ,
  }, async (args) => {
    const shopId = await shop.resolve(args.shop_id);
    const params = paginationParams({ limit: args.limit, offset: args.offset });
    const data = await client.get<{ count: number; results: unknown[] }>(`/shops/${shopId}/transactions`, params);
    return { content: [{ type: "text" as const, text: formatPaginatedResponse(data, args.limit ?? 25, args.offset ?? 0) }] };
  });

  server.registerTool("get_transaction", {
    description: "Get a specific transaction by ID",
    inputSchema: {
      shop_id: shopIdArg,
      transaction_id: z.number().describe("The transaction ID"),
    },
    annotations: READ,
  }, async (args) => {
    const shopId = await shop.resolve(args.shop_id);
    const data = await client.get(`/shops/${shopId}/transactions/${args.transaction_id}`);
    return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
  });

  server.registerTool("get_transactions_by_receipt", {
    description: "Get all transactions for a specific receipt",
    inputSchema: {
      shop_id: shopIdArg,
      receipt_id: z.number().describe("The receipt ID"),
    },
    annotations: READ,
  }, async (args) => {
    const shopId = await shop.resolve(args.shop_id);
    const data = await client.get(`/shops/${shopId}/receipts/${args.receipt_id}/transactions`);
    return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
  });
}
```

- [ ] **Step 9: Rewrite `src/tools/reviews.ts`**

```ts
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { EtsyClient } from "../client/etsy-client.js";
import type { ShopContext } from "../client/shop-context.js";
import { paginationParams, formatPaginatedResponse } from "../utils/pagination.js";
import { READ } from "./annotations.js";
import { shopIdArg } from "./args.js";

export function registerReviewsTools(server: McpServer, client: EtsyClient, shop: ShopContext): void {
  server.registerTool("get_reviews_by_listing", {
    description: "Get reviews for a specific listing",
    inputSchema: {
      listing_id: z.number().describe("The listing ID"),
      limit: z.number().optional().describe("Results per page"),
      offset: z.number().optional().describe("Offset for pagination"),
    },
    annotations: READ,
  }, async (args) => {
    const params = paginationParams({ limit: args.limit, offset: args.offset });
    const data = await client.get<{ count: number; results: unknown[] }>(`/listings/${args.listing_id}/reviews`, params);
    return { content: [{ type: "text" as const, text: formatPaginatedResponse(data, args.limit ?? 25, args.offset ?? 0) }] };
  });

  server.registerTool("get_reviews_by_shop", {
    description: "Get reviews for a shop",
    inputSchema: {
      shop_id: shopIdArg,
      limit: z.number().optional().describe("Results per page"),
      offset: z.number().optional().describe("Offset for pagination"),
    },
    annotations: READ,
  }, async (args) => {
    const shopId = await shop.resolve(args.shop_id);
    const params = paginationParams({ limit: args.limit, offset: args.offset });
    const data = await client.get<{ count: number; results: unknown[] }>(`/shops/${shopId}/reviews`, params);
    return { content: [{ type: "text" as const, text: formatPaginatedResponse(data, args.limit ?? 25, args.offset ?? 0) }] };
  });
}
```

- [ ] **Step 10: Rewrite `src/tools/taxonomy.ts`**

```ts
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { EtsyClient } from "../client/etsy-client.js";
import { READ } from "./annotations.js";

export function registerTaxonomyTools(server: McpServer, client: EtsyClient): void {
  server.registerTool("get_buyer_taxonomy", {
    description: "Get the full buyer taxonomy tree (categories)",
    annotations: READ,
  }, async () => {
    const data = await client.get("/buyer-taxonomy/nodes");
    return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
  });

  server.registerTool("get_taxonomy_properties", {
    description: "Get properties for a specific taxonomy/category node",
    inputSchema: { taxonomy_id: z.number().describe("The taxonomy node ID") },
    annotations: READ,
  }, async (args) => {
    const data = await client.get(`/buyer-taxonomy/nodes/${args.taxonomy_id}/properties`);
    return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
  });
}
```

- [ ] **Step 11: Rewrite `src/tools/images.ts`** (upload guard comes in Task 5)

```ts
import { z } from "zod";
import { readFile } from "node:fs/promises";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { EtsyClient } from "../client/etsy-client.js";
import type { ShopContext } from "../client/shop-context.js";
import { READ, WRITE_ADDITIVE, WRITE_DESTRUCTIVE } from "./annotations.js";
import { shopIdArg } from "./args.js";

export function registerImagesTools(server: McpServer, client: EtsyClient, shop: ShopContext): void {
  server.registerTool("get_listing_images", {
    description: "Get all images for a listing",
    inputSchema: { listing_id: z.number().describe("The listing ID") },
    annotations: READ,
  }, async (args) => {
    const data = await client.get(`/listings/${args.listing_id}/images`);
    return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
  });

  server.registerTool("upload_listing_image", {
    description: "Upload an image to a listing from a local file path",
    inputSchema: {
      shop_id: shopIdArg,
      listing_id: z.number().describe("The listing ID"),
      image_path: z.string().describe("Local file path to the image"),
      rank: z.number().optional().describe("Image rank/position (1-10)"),
      overwrite: z.boolean().optional().describe("Overwrite existing image at rank"),
      is_watermarked: z.boolean().optional().describe("Image has watermark"),
      alt_text: z.string().optional().describe("Alt text for the image"),
    },
    annotations: WRITE_ADDITIVE,
  }, async (args) => {
    const shopId = await shop.resolve(args.shop_id);
    const imageBuffer = await readFile(args.image_path);
    const blob = new Blob([imageBuffer]);
    const formData = new FormData();
    formData.append("image", blob, args.image_path.split("/").pop() ?? "image.jpg");
    if (args.rank) formData.append("rank", String(args.rank));
    if (args.overwrite !== undefined) formData.append("overwrite", String(args.overwrite));
    if (args.is_watermarked !== undefined) formData.append("is_watermarked", String(args.is_watermarked));
    if (args.alt_text) formData.append("alt_text", args.alt_text);
    const data = await client.uploadFile(`/shops/${shopId}/listings/${args.listing_id}/images`, formData);
    return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
  });

  server.registerTool("upload_listing_video", {
    description: "Upload a video to a listing from a local file path (max 15 seconds)",
    inputSchema: {
      shop_id: shopIdArg,
      listing_id: z.number().describe("The listing ID"),
      video_path: z.string().describe("Local file path to the video"),
    },
    annotations: WRITE_ADDITIVE,
  }, async (args) => {
    const shopId = await shop.resolve(args.shop_id);
    const videoBuffer = await readFile(args.video_path);
    const blob = new Blob([videoBuffer]);
    const formData = new FormData();
    formData.append("video", blob, args.video_path.split("/").pop() ?? "video.mp4");
    const data = await client.uploadFile(`/shops/${shopId}/listings/${args.listing_id}/videos`, formData);
    return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
  });

  server.registerTool("delete_listing_image", {
    description: "Delete an image from a listing",
    inputSchema: {
      shop_id: shopIdArg,
      listing_id: z.number().describe("The listing ID"),
      listing_image_id: z.number().describe("The image ID to delete"),
    },
    annotations: WRITE_DESTRUCTIVE,
  }, async (args) => {
    const shopId = await shop.resolve(args.shop_id);
    await client.delete(`/shops/${shopId}/listings/${args.listing_id}/images/${args.listing_image_id}`);
    return { content: [{ type: "text" as const, text: `Image ${args.listing_image_id} deleted from listing ${args.listing_id}.` }] };
  });
}
```

- [ ] **Step 12: Rewrite `src/tools/inventory.ts`**

```ts
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { EtsyClient } from "../client/etsy-client.js";
import { READ, WRITE_DESTRUCTIVE } from "./annotations.js";

export function registerInventoryTools(server: McpServer, client: EtsyClient): void {
  server.registerTool("get_listing_inventory", {
    description: "Get inventory (products, offerings, variations) for a listing",
    inputSchema: { listing_id: z.number().describe("The listing ID") },
    annotations: READ,
  }, async (args) => {
    const data = await client.get(`/listings/${args.listing_id}/inventory`);
    return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
  });

  server.registerTool("update_listing_inventory", {
    description: "Update inventory for a listing (products with offerings and prices)",
    inputSchema: {
      listing_id: z.number().describe("The listing ID"),
      products: z.array(z.object({
        sku: z.string().optional().describe("SKU"),
        property_values: z.array(z.object({
          property_id: z.number(),
          value_ids: z.array(z.number()),
          values: z.array(z.string()),
        })).optional(),
        offerings: z.array(z.object({
          price: z.number().describe("Price"),
          quantity: z.number().describe("Quantity"),
          is_enabled: z.boolean().describe("Is this offering enabled"),
        })),
      })).describe("Product inventory data"),
    },
    annotations: WRITE_DESTRUCTIVE,
  }, async (args) => {
    const data = await client.put(`/listings/${args.listing_id}/inventory`, { products: args.products });
    return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
  });
}
```

- [ ] **Step 13: Rewrite `src/tools/payments.ts`**

```ts
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { EtsyClient } from "../client/etsy-client.js";
import type { ShopContext } from "../client/shop-context.js";
import { paginationParams, formatPaginatedResponse } from "../utils/pagination.js";
import { READ } from "./annotations.js";
import { shopIdArg } from "./args.js";

export function registerPaymentsTools(server: McpServer, client: EtsyClient, shop: ShopContext): void {
  server.registerTool("get_payments", {
    description: "Get payments for a shop or a specific receipt (read-only)",
    inputSchema: {
      shop_id: shopIdArg,
      receipt_id: z.number().optional().describe("Filter by receipt ID"),
    },
    annotations: READ,
  }, async (args) => {
    const shopId = await shop.resolve(args.shop_id);
    const path = args.receipt_id
      ? `/shops/${shopId}/receipts/${args.receipt_id}/payments`
      : `/shops/${shopId}/payments`;
    const data = await client.get(path);
    return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
  });

  server.registerTool("get_ledger_entries", {
    description: "Get payment account ledger entries for a shop (fees, payouts)",
    inputSchema: {
      shop_id: shopIdArg,
      min_created: z.number().optional().describe("Minimum creation timestamp"),
      max_created: z.number().optional().describe("Maximum creation timestamp"),
      limit: z.number().optional().describe("Results per page"),
      offset: z.number().optional().describe("Offset for pagination"),
    },
    annotations: READ,
  }, async (args) => {
    const shopId = await shop.resolve(args.shop_id);
    const params: Record<string, string> = { ...paginationParams({ limit: args.limit, offset: args.offset }) };
    if (args.min_created) params.min_created = String(args.min_created);
    if (args.max_created) params.max_created = String(args.max_created);
    const data = await client.get<{ count: number; results: unknown[] }>(`/shops/${shopId}/payment-account/ledger-entries`, params);
    return { content: [{ type: "text" as const, text: formatPaginatedResponse(data, args.limit ?? 25, args.offset ?? 0) }] };
  });
}
```

- [ ] **Step 14: Delete the removed modules and their tests**

```bash
git rm src/tools/users.ts src/tools/shipping.ts src/tools/return-policies.ts \
  tests/unit/tools/users.test.ts tests/unit/tools/shipping.test.ts tests/unit/tools/return-policies.test.ts
```

- [ ] **Step 15: Rewire `src/index.ts`**

Replace these three import lines:
```ts
import { registerShippingTools } from "./tools/shipping.js";
```
```ts
import { registerUsersTools } from "./tools/users.js";
```
```ts
import { registerReturnPoliciesTools } from "./tools/return-policies.js";
```
with nothing (delete them), and add after `import { EtsyClient } from "./client/etsy-client.js";`:
```ts
import { ShopContext } from "./client/shop-context.js";
import { READ } from "./tools/annotations.js";
```

In `createEtsyMcpServer`, replace the `authenticate` config object:
```ts
    {
      description: "Authenticate with Etsy via OAuth 2.0. Opens a browser for consent. Required before using tools that need user authorization.",
    },
```
with:
```ts
    {
      description: "Authenticate with Etsy via OAuth 2.0. Opens a browser for consent. Required before using tools that need user authorization.",
      annotations: READ,
    },
```

Replace the block from `registerListingsTools(server, client);` through `registerReturnPoliciesTools(server, client);` with:
```ts
  const shop = new ShopContext(client);

  registerListingsTools(server, client, shop);
  registerShopTools(server, client, shop);
  registerOrdersTools(server, client, shop);
  registerTransactionsTools(server, client, shop);
  registerReviewsTools(server, client, shop);
  registerTaxonomyTools(server, client);
  registerImagesTools(server, client, shop);
  registerInventoryTools(server, client);
  registerPaymentsTools(server, client, shop);
```

- [ ] **Step 16: Run the full suite and type check**

Run: `npm run lint && npm test`
Expected: lint clean; all test files pass, including the 6 registry tests. (The upstream per-module "registers without error" tests still pass: they call `registerXTools(server, client)` and the missing `shop` is only read inside handlers.)

- [ ] **Step 17: Commit**

```bash
git add -A src tests
git commit -m "feat: trim to 31 shop tools, default shop_id, annotate reads and writes" -m "Removes shop admin, shipping-profile, return-policy and user tools and delete_listing; moves get_me, get_shipping_profiles and get_shipping_carriers." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: `get_unshipped_orders`

**Files:**
- Modify: `src/tools/orders.ts`
- Modify: `tests/unit/tools/orders.test.ts` (full rewrite)
- Modify: `tests/unit/registry.test.ts` (`READS` array)

**Interfaces:**
- Consumes: `registerOrdersTools(server, client, shop)`, `shopIdArg`, `READ`, `connectClient`, `textOf` (Task 2)
- Produces: tool `get_unshipped_orders` `{ shop_id?, limit?, offset? }`

- [ ] **Step 1: Write the failing test**

Replace `tests/unit/tools/orders.test.ts` with:
```ts
import { describe, it, expect, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerOrdersTools } from "../../../src/tools/orders.js";
import { ShopContext } from "../../../src/client/shop-context.js";
import type { EtsyClient } from "../../../src/client/etsy-client.js";
import { connectClient, textOf } from "../../helpers/mcp.js";

describe("Orders Tools", () => {
  it("get_unshipped_orders asks for paid, unshipped, non-canceled receipts, oldest first", async () => {
    const get = vi.fn().mockResolvedValue({ count: 1, results: [{ receipt_id: 9 }] });
    const client = { get } as unknown as EtsyClient;
    const server = new McpServer({ name: "test", version: "0.0.0" });
    registerOrdersTools(server, client, new ShopContext(client));
    const mcp = await connectClient(server);

    const result = await mcp.callTool({ name: "get_unshipped_orders", arguments: { shop_id: 55 } });

    expect(get).toHaveBeenCalledWith("/shops/55/receipts", {
      limit: "25",
      offset: "0",
      was_paid: "true",
      was_shipped: "false",
      was_canceled: "false",
      sort_on: "created",
      sort_order: "asc",
    });
    expect(JSON.parse(textOf(result))).toMatchObject({ count: 1, results: [{ receipt_id: 9 }] });
  });
});
```

In `tests/unit/registry.test.ts`, change the line
```ts
  "get_receipt", "get_reviews_by_listing", "get_reviews_by_shop", "get_shipping_carriers",
```
to
```ts
  "get_receipt", "get_reviews_by_listing", "get_reviews_by_shop", "get_shipping_carriers", "get_unshipped_orders",
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/tools/orders.test.ts tests/unit/registry.test.ts`
Expected: FAIL — `Tool get_unshipped_orders not found`; registry name list missing `get_unshipped_orders`.

- [ ] **Step 3: Implement**

In `src/tools/orders.ts`, insert after the `get_receipt` registration:
```ts
  server.registerTool("get_unshipped_orders", {
    description: "List paid orders that still need shipping (not shipped, not canceled), oldest first",
    inputSchema: {
      shop_id: shopIdArg,
      limit: z.number().optional().describe("Results per page (max 100)"),
      offset: z.number().optional().describe("Offset for pagination"),
    },
    annotations: READ,
  }, async (args) => {
    const shopId = await shop.resolve(args.shop_id);
    const params: Record<string, string> = {
      ...paginationParams({ limit: args.limit, offset: args.offset }),
      was_paid: "true",
      was_shipped: "false",
      was_canceled: "false",
      sort_on: "created",
      sort_order: "asc",
    };
    const data = await client.get<{ count: number; results: unknown[] }>(`/shops/${shopId}/receipts`, params);
    return { content: [{ type: "text" as const, text: formatPaginatedResponse(data, args.limit ?? 25, args.offset ?? 0) }] };
  });
```

- [ ] **Step 4: Run tests**

Run: `npm run lint && npm test`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/tools/orders.ts tests/unit/tools/orders.test.ts tests/unit/registry.test.ts
git commit -m "feat: add get_unshipped_orders" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: `get_sales_summary`

**Files:**
- Create: `src/utils/money.ts`, `src/tools/stats.ts`
- Test: `tests/unit/utils/money.test.ts`, `tests/unit/tools/stats.test.ts`
- Modify: `src/index.ts`, `tests/unit/registry.test.ts`

**Interfaces:**
- Consumes: `ShopContext`, `shopIdArg`, `READ` (Tasks 1–2)
- Produces:
  - `interface EtsyMoney { amount: number; divisor: number; currency_code: string }`, `toCents(money: EtsyMoney): number`, `centsToDecimal(cents: number): number`
  - `dayRangeUtc(startDate: string, endDate: string): { min: number; max: number }`
  - `buildSalesSummary(client: Pick<EtsyClient, "get">, shopId: number, startDate: string, endDate: string): Promise<SalesSummary>`
  - `registerStatsTools(server: McpServer, client: EtsyClient, shop: ShopContext): void`, tool `get_sales_summary`

- [ ] **Step 1: Write the failing money test**

Create `tests/unit/utils/money.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { toCents, centsToDecimal } from "../../../src/utils/money.js";

describe("money", () => {
  it("converts Etsy money to hundredths using the divisor", () => {
    expect(toCents({ amount: 2599, divisor: 100, currency_code: "USD" })).toBe(2599);
    expect(toCents({ amount: 1000, divisor: 1, currency_code: "JPY" })).toBe(100000);
    expect(toCents({ amount: 12345, divisor: 1000, currency_code: "USD" })).toBe(1235);
  });

  it("turns hundredths back into a decimal", () => {
    expect(centsToDecimal(4149)).toBe(41.49);
  });
});
```

- [ ] **Step 2: Write the failing stats test**

Create `tests/unit/tools/stats.test.ts`:
```ts
import { describe, it, expect, vi } from "vitest";
import { buildSalesSummary, dayRangeUtc, MAX_RECEIPTS } from "../../../src/tools/stats.js";

type Page = { count: number; results: unknown[] };
const usd = (amount: number) => ({ amount, divisor: 100, currency_code: "USD" });

function fakeEtsy(receiptPages: Page[], listingPages: Page[]) {
  let r = 0;
  let l = 0;
  const get = vi.fn(async (path: string) => {
    if (path.endsWith("/receipts")) return receiptPages[r++] ?? { count: 0, results: [] };
    if (path.endsWith("/listings")) return listingPages[l++] ?? { count: 0, results: [] };
    throw new Error(`unexpected path ${path}`);
  });
  return { get };
}

describe("dayRangeUtc", () => {
  it("covers whole UTC days, inclusive", () => {
    expect(dayRangeUtc("2026-09-01", "2026-09-30")).toEqual({
      min: Date.UTC(2026, 8, 1) / 1000,
      max: Date.UTC(2026, 8, 30, 23, 59, 59) / 1000,
    });
  });

  it("rejects bad or reversed dates", () => {
    expect(() => dayRangeUtc("2026-13-01", "2026-12-01")).toThrow("Invalid date");
    expect(() => dayRangeUtc("2026-09-30", "2026-09-01")).toThrow("on or before");
  });
});

describe("buildSalesSummary", () => {
  it("totals non-refunded orders, ranks listings, and finds slow movers", async () => {
    const etsy = fakeEtsy(
      [{
        count: 3,
        results: [
          { status: "paid", grandtotal: usd(2599), subtotal: usd(2000), transactions: [{ listing_id: 10, title: "Mug", quantity: 2, price: usd(1000) }] },
          { status: "completed", grandtotal: usd(1550), subtotal: usd(1200), transactions: [{ listing_id: 20, title: "Print", quantity: 1, price: usd(1200) }] },
          { status: "fully refunded", grandtotal: usd(5000), subtotal: usd(5000), transactions: [{ listing_id: 30, title: "Lamp", quantity: 1, price: usd(5000) }] },
        ],
      }],
      [{
        count: 3,
        results: [
          { listing_id: 10, title: "Mug", created_timestamp: 1700000000 },
          { listing_id: 40, title: "Old sticker", created_timestamp: 1600000000 },
          { listing_id: 30, title: "Lamp", created_timestamp: 1650000000 },
        ],
      }],
    );

    const summary = await buildSalesSummary(etsy, 7, "2026-09-01", "2026-09-30");

    expect(summary).toEqual({
      period: { start_date: "2026-09-01", end_date: "2026-09-30", timezone: "UTC" },
      currency: "USD",
      orders: 2,
      units: 3,
      item_subtotal: 32,
      gross_total: 41.49,
      excluded_refunded_orders: 1,
      truncated: false,
      top_listings: [
        { listing_id: 10, title: "Mug", units: 2, revenue: 20 },
        { listing_id: 20, title: "Print", units: 1, revenue: 12 },
      ],
      slow_movers: [
        { listing_id: 40, title: "Old sticker", created: "2020-09-13" },
        { listing_id: 30, title: "Lamp", created: "2022-04-15" },
      ],
    });
    expect(etsy.get).toHaveBeenNthCalledWith(1, "/shops/7/receipts", {
      min_created: String(Date.UTC(2026, 8, 1) / 1000),
      max_created: String(Date.UTC(2026, 8, 30, 23, 59, 59) / 1000),
      was_canceled: "false",
      sort_on: "created",
      sort_order: "asc",
      limit: "100",
      offset: "0",
    });
    expect(etsy.get).toHaveBeenNthCalledWith(2, "/shops/7/listings", {
      state: "active",
      sort_on: "created",
      sort_order: "asc",
      limit: "100",
      offset: "0",
    });
  });

  it("stops at the receipt cap and says so", async () => {
    const fullPage = {
      count: 2500,
      results: Array.from({ length: 100 }, () => ({ status: "paid", grandtotal: usd(100), subtotal: usd(100), transactions: [] })),
    };
    const etsy = fakeEtsy(Array.from({ length: 25 }, () => fullPage), []);

    const summary = await buildSalesSummary(etsy, 7, "2026-01-01", "2026-12-31");

    const receiptCalls = etsy.get.mock.calls.filter(([path]) => path.endsWith("/receipts"));
    expect(receiptCalls).toHaveLength(MAX_RECEIPTS / 100);
    expect(summary.orders).toBe(MAX_RECEIPTS);
    expect(summary.truncated).toBe(true);
  });

  it("reports no currency when there were no orders", async () => {
    const summary = await buildSalesSummary(fakeEtsy([], []), 7, "2026-09-01", "2026-09-01");
    expect(summary).toMatchObject({ orders: 0, units: 0, gross_total: 0, currency: null, top_listings: [], slow_movers: [] });
  });
});
```

In `tests/unit/registry.test.ts`, change the line
```ts
  "get_receipt", "get_reviews_by_listing", "get_reviews_by_shop", "get_shipping_carriers", "get_unshipped_orders",
```
to
```ts
  "get_receipt", "get_reviews_by_listing", "get_reviews_by_shop", "get_sales_summary", "get_shipping_carriers", "get_unshipped_orders",
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run tests/unit/utils/money.test.ts tests/unit/tools/stats.test.ts tests/unit/registry.test.ts`
Expected: FAIL — modules `money.js` / `stats.js` not found; registry missing `get_sales_summary`.

- [ ] **Step 4: Implement `src/utils/money.ts`**

```ts
/** Etsy's money object: amount / divisor = value in currency_code. */
export interface EtsyMoney {
  amount: number;
  divisor: number;
  currency_code: string;
}

/** Converts to whole hundredths so sums don't drift with floating point. */
export function toCents(money: EtsyMoney): number {
  return Math.round((money.amount * 100) / money.divisor);
}

export function centsToDecimal(cents: number): number {
  return cents / 100;
}
```

- [ ] **Step 5: Implement `src/tools/stats.ts`**

```ts
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { EtsyClient } from "../client/etsy-client.js";
import type { ShopContext } from "../client/shop-context.js";
import { centsToDecimal, toCents, type EtsyMoney } from "../utils/money.js";
import { READ } from "./annotations.js";
import { shopIdArg } from "./args.js";

const PAGE_SIZE = 100;
/** Bounds API usage: 20 receipt pages per summary. */
export const MAX_RECEIPTS = 2000;
const MAX_LISTINGS_SCANNED = 500;
const TOP_LISTINGS = 10;
const SLOW_MOVERS = 20;

interface Page<T> {
  count: number;
  results: T[];
}

interface Receipt {
  status: string;
  grandtotal: EtsyMoney;
  subtotal: EtsyMoney;
  transactions?: Array<{ listing_id: number; title: string; quantity: number; price: EtsyMoney }>;
}

interface Listing {
  listing_id: number;
  title: string;
  created_timestamp: number;
}

export interface SalesSummary {
  period: { start_date: string; end_date: string; timezone: "UTC" };
  currency: string | null;
  orders: number;
  units: number;
  item_subtotal: number;
  gross_total: number;
  excluded_refunded_orders: number;
  truncated: boolean;
  top_listings: Array<{ listing_id: number; title: string; units: number; revenue: number }>;
  slow_movers: Array<{ listing_id: number; title: string; created: string }>;
}

/** Inclusive range of whole UTC days, as epoch seconds. */
export function dayRangeUtc(startDate: string, endDate: string): { min: number; max: number } {
  const min = Date.parse(`${startDate}T00:00:00Z`) / 1000;
  const max = Date.parse(`${endDate}T23:59:59Z`) / 1000;
  if (Number.isNaN(min) || Number.isNaN(max)) {
    throw new Error("Invalid date. Use YYYY-MM-DD.");
  }
  if (min > max) {
    throw new Error("start_date must be on or before end_date.");
  }
  return { min, max };
}

export async function buildSalesSummary(
  client: Pick<EtsyClient, "get">,
  shopId: number,
  startDate: string,
  endDate: string
): Promise<SalesSummary> {
  const { min, max } = dayRangeUtc(startDate, endDate);

  const receipts: Receipt[] = [];
  let receiptCount = 0;
  for (let offset = 0; offset < MAX_RECEIPTS; offset += PAGE_SIZE) {
    const page = await client.get<Page<Receipt>>(`/shops/${shopId}/receipts`, {
      min_created: String(min),
      max_created: String(max),
      was_canceled: "false",
      sort_on: "created",
      sort_order: "asc",
      limit: String(PAGE_SIZE),
      offset: String(offset),
    });
    receiptCount = page.count;
    receipts.push(...page.results);
    if (offset + page.results.length >= page.count || page.results.length === 0) break;
  }

  // Canceled orders are filtered by Etsy; fully refunded ones are dropped here.
  const counted = receipts.filter((receipt) => receipt.status !== "fully refunded");

  let grossCents = 0;
  let subtotalCents = 0;
  let units = 0;
  const byListing = new Map<number, { listing_id: number; title: string; units: number; cents: number }>();
  for (const receipt of counted) {
    grossCents += toCents(receipt.grandtotal);
    subtotalCents += toCents(receipt.subtotal);
    for (const line of receipt.transactions ?? []) {
      units += line.quantity;
      const row = byListing.get(line.listing_id) ?? { listing_id: line.listing_id, title: line.title, units: 0, cents: 0 };
      row.units += line.quantity;
      row.cents += toCents(line.price) * line.quantity;
      byListing.set(line.listing_id, row);
    }
  }

  const slowMovers: Listing[] = [];
  for (let offset = 0; offset < MAX_LISTINGS_SCANNED && slowMovers.length < SLOW_MOVERS; offset += PAGE_SIZE) {
    const page = await client.get<Page<Listing>>(`/shops/${shopId}/listings`, {
      state: "active",
      sort_on: "created",
      sort_order: "asc",
      limit: String(PAGE_SIZE),
      offset: String(offset),
    });
    for (const listing of page.results) {
      if (!byListing.has(listing.listing_id) && slowMovers.length < SLOW_MOVERS) slowMovers.push(listing);
    }
    if (offset + page.results.length >= page.count || page.results.length === 0) break;
  }

  return {
    period: { start_date: startDate, end_date: endDate, timezone: "UTC" },
    currency: counted[0]?.grandtotal.currency_code ?? null,
    orders: counted.length,
    units,
    item_subtotal: centsToDecimal(subtotalCents),
    gross_total: centsToDecimal(grossCents),
    excluded_refunded_orders: receipts.length - counted.length,
    truncated: receiptCount > MAX_RECEIPTS,
    top_listings: [...byListing.values()]
      .sort((a, b) => b.cents - a.cents)
      .slice(0, TOP_LISTINGS)
      .map((row) => ({ listing_id: row.listing_id, title: row.title, units: row.units, revenue: centsToDecimal(row.cents) })),
    slow_movers: slowMovers.map((listing) => ({
      listing_id: listing.listing_id,
      title: listing.title,
      created: new Date(listing.created_timestamp * 1000).toISOString().slice(0, 10),
    })),
  };
}

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");

export function registerStatsTools(server: McpServer, client: EtsyClient, shop: ShopContext): void {
  server.registerTool("get_sales_summary", {
    description:
      "Sales summary for a date range (whole UTC days, inclusive): orders, units, item subtotal, gross total, " +
      "top 10 listings by revenue, and up to 20 active listings with no sales in the range. " +
      "Canceled and fully refunded orders are excluded.",
    inputSchema: {
      start_date: isoDate.describe("First day, YYYY-MM-DD (UTC)"),
      end_date: isoDate.describe("Last day, YYYY-MM-DD (UTC), inclusive"),
      shop_id: shopIdArg,
    },
    annotations: READ,
  }, async (args) => {
    const shopId = await shop.resolve(args.shop_id);
    const summary = await buildSalesSummary(client, shopId, args.start_date, args.end_date);
    return { content: [{ type: "text" as const, text: JSON.stringify(summary, null, 2) }] };
  });
}
```

- [ ] **Step 6: Register in `src/index.ts`**

Add after `import { registerPaymentsTools } from "./tools/payments.js";`:
```ts
import { registerStatsTools } from "./tools/stats.js";
```
Add after `registerPaymentsTools(server, client, shop);`:
```ts
  registerStatsTools(server, client, shop);
```

- [ ] **Step 7: Run tests**

Run: `npm run lint && npm test`
Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add src/utils/money.ts src/tools/stats.ts src/index.ts tests/unit/utils/money.test.ts tests/unit/tools/stats.test.ts tests/unit/registry.test.ts
git commit -m "feat: add get_sales_summary with top sellers and slow movers" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Upload path guard (F5)

**Files:**
- Modify: `src/tools/images.ts`
- Modify: `tests/unit/tools/images.test.ts` (full rewrite)

**Interfaces:**
- Consumes: `registerImagesTools(server, client, shop)` (Task 2)
- Produces: `IMAGE_EXTENSIONS`, `VIDEO_EXTENSIONS: readonly string[]`; `checkUploadPath(filePath: string, allowed: readonly string[]): { path: string; name: string }`

- [ ] **Step 1: Write the failing test**

Replace `tests/unit/tools/images.test.ts` with:
```ts
import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerImagesTools, checkUploadPath, IMAGE_EXTENSIONS, VIDEO_EXTENSIONS } from "../../../src/tools/images.js";
import { ShopContext } from "../../../src/client/shop-context.js";
import type { EtsyClient } from "../../../src/client/etsy-client.js";
import { connectClient, textOf } from "../../helpers/mcp.js";

describe("checkUploadPath", () => {
  it("accepts allowed extensions in any case and returns the file name", () => {
    const photo = join(tmpdir(), "photos", "a.PNG");
    expect(checkUploadPath(photo, IMAGE_EXTENSIONS)).toEqual({ path: photo, name: "a.PNG" });
    expect(checkUploadPath(join(tmpdir(), "clip.MOV"), VIDEO_EXTENSIONS).name).toBe("clip.MOV");
  });

  it("refuses everything else", () => {
    expect(() => checkUploadPath(join(tmpdir(), ".env"), IMAGE_EXTENSIONS)).toThrow("Refusing to upload");
    expect(() => checkUploadPath(join(tmpdir(), "tool.exe"), IMAGE_EXTENSIONS)).toThrow("Refusing to upload");
    expect(() => checkUploadPath(join(tmpdir(), "a.png"), VIDEO_EXTENSIONS)).toThrow("Refusing to upload");
  });
});

describe("upload_listing_image", () => {
  async function setup() {
    const uploadFile = vi.fn().mockResolvedValue({ listing_image_id: 1 });
    const client = { get: vi.fn(), uploadFile, delete: vi.fn() } as unknown as EtsyClient;
    const server = new McpServer({ name: "test", version: "0.0.0" });
    registerImagesTools(server, client, new ShopContext(client));
    return { uploadFile, mcp: await connectClient(server) };
  }

  it("refuses a non-image file without contacting Etsy", async () => {
    const { uploadFile, mcp } = await setup();
    const result = await mcp.callTool({
      name: "upload_listing_image",
      arguments: { shop_id: 1, listing_id: 2, image_path: join(tmpdir(), "secrets.env") },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Refusing to upload");
    expect(uploadFile).not.toHaveBeenCalled();
  });

  it("uploads an image under its own file name", async () => {
    const dir = mkdtempSync(join(tmpdir(), "etsy-img-"));
    const file = join(dir, "Mug Front.JPG");
    writeFileSync(file, "fake-bytes");
    const { uploadFile, mcp } = await setup();

    await mcp.callTool({ name: "upload_listing_image", arguments: { shop_id: 1, listing_id: 2, image_path: file } });

    expect(uploadFile).toHaveBeenCalledOnce();
    const [path, form] = uploadFile.mock.calls[0]!;
    expect(path).toBe("/shops/1/listings/2/images");
    expect(((form as FormData).get("image") as File).name).toBe("Mug Front.JPG");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/tools/images.test.ts`
Expected: FAIL — `checkUploadPath` is not exported; the `.env` upload is attempted (ENOENT, not "Refusing to upload").

- [ ] **Step 3: Implement**

In `src/tools/images.ts`, replace
```ts
import { readFile } from "node:fs/promises";
```
with
```ts
import { readFile } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
```

Add after the imports, before `export function registerImagesTools`:
```ts
export const IMAGE_EXTENSIONS = [".jpg", ".jpeg", ".png", ".gif", ".webp"] as const;
export const VIDEO_EXTENSIONS = [".mp4", ".mov"] as const;

/** Upload tools read local files, so only media files may leave the machine. */
export function checkUploadPath(filePath: string, allowed: readonly string[]): { path: string; name: string } {
  const path = resolve(filePath);
  const name = basename(path);
  if (!allowed.includes(extname(path).toLowerCase())) {
    throw new Error(`Refusing to upload ${name}: only ${allowed.join(", ")} files are allowed.`);
  }
  return { path, name };
}
```

In the `upload_listing_image` handler, replace
```ts
    const shopId = await shop.resolve(args.shop_id);
    const imageBuffer = await readFile(args.image_path);
    const blob = new Blob([imageBuffer]);
    const formData = new FormData();
    formData.append("image", blob, args.image_path.split("/").pop() ?? "image.jpg");
```
with
```ts
    const file = checkUploadPath(args.image_path, IMAGE_EXTENSIONS);
    const shopId = await shop.resolve(args.shop_id);
    const imageBuffer = await readFile(file.path);
    const formData = new FormData();
    formData.append("image", new Blob([imageBuffer]), file.name);
```

In the `upload_listing_video` handler, replace
```ts
    const shopId = await shop.resolve(args.shop_id);
    const videoBuffer = await readFile(args.video_path);
    const blob = new Blob([videoBuffer]);
    const formData = new FormData();
    formData.append("video", blob, args.video_path.split("/").pop() ?? "video.mp4");
```
with
```ts
    const file = checkUploadPath(args.video_path, VIDEO_EXTENSIONS);
    const shopId = await shop.resolve(args.shop_id);
    const videoBuffer = await readFile(file.path);
    const formData = new FormData();
    formData.append("video", new Blob([videoBuffer]), file.name);
```

- [ ] **Step 4: Run tests**

Run: `npm run lint && npm test`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/tools/images.ts tests/unit/tools/images.test.ts
git commit -m "fix: only upload image and video files, keep Windows file names" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Never auto-retry POST/PATCH after a failure (F3)

**Files:**
- Modify: `src/client/etsy-client.ts`
- Test: `tests/unit/client/etsy-client.test.ts` (append)

**Interfaces:**
- Produces: unchanged public API; POST/PATCH 5xx → `EtsyApiError` whose message contains "Not retried automatically"; POST/PATCH network error → `Error` with the same phrase.

- [ ] **Step 1: Write the failing tests**

Append inside the `describe("EtsyClient", ...)` block in `tests/unit/client/etsy-client.test.ts`:
```ts
  it("does not retry POST after a 5xx", async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: false, status: 503, json: () => Promise.resolve({}) })
      .mockResolvedValueOnce({ ok: true, status: 201, json: () => Promise.resolve({ created: true }) });

    await expect(client.post("/shops/1/receipts/2/tracking", {})).rejects.toThrow("Not retried automatically");
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("does not retry PATCH after a network error", async () => {
    mockFetch
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({}) });

    await expect(client.patch("/shops/1/listings/2", { title: "x" })).rejects.toThrow("fetch failed");
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("still retries POST on 429, which Etsy never processed", async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: false, status: 429, headers: new Headers({ "Retry-After": "0" }), json: () => Promise.resolve({}) })
      .mockResolvedValueOnce({ ok: true, status: 201, json: () => Promise.resolve({ created: true }) });

    await expect(client.post("/shops/1/listings", {})).resolves.toEqual({ created: true });
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("retries GET after a network error", async () => {
    mockFetch
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({ ok: 1 }) });

    await expect(client.get("/listings/active")).resolves.toEqual({ ok: 1 });
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/client/etsy-client.test.ts`
Expected: FAIL — POST 503 resolves `{ created: true }` after a retry; PATCH resolves after a retry.

- [ ] **Step 3: Implement**

In `src/client/etsy-client.ts`, replace
```ts
const RETRY_DELAY_MS = 1000;
```
with
```ts
const RETRY_DELAY_MS = 1000;
/** Repeating these is harmless. POST/PATCH may already have been applied when the reply was lost. */
const RETRY_SAFE_METHODS = new Set(["GET", "PUT", "DELETE"]);

function notRetried(method: string, path: string, reason: string): string {
  return `${method} ${path} failed (${reason}). Not retried automatically because Etsy may already have applied it; check before trying again.`;
}
```

In `request()`, replace
```ts
    let lastError: Error | undefined;
```
with
```ts
    const retrySafe = RETRY_SAFE_METHODS.has(method);
    let lastError: Error | undefined;
```

Replace
```ts
        if (response.status >= 500) {
          lastError = new EtsyApiError(response.status, await response.json().catch(() => null));
          continue;
        }
```
with
```ts
        if (response.status >= 500) {
          const errorBody = await response.json().catch(() => null);
          if (!retrySafe) {
            throw new EtsyApiError(response.status, errorBody, notRetried(method, path, `Etsy API error (${response.status})`));
          }
          lastError = new EtsyApiError(response.status, errorBody);
          continue;
        }
```

Replace
```ts
      } catch (err) {
        if (err instanceof EtsyApiError) throw err;
        lastError = err as Error;
```
with
```ts
      } catch (err) {
        if (err instanceof EtsyApiError) throw err;
        if (!retrySafe) throw new Error(notRetried(method, path, (err as Error).message));
        lastError = err as Error;
```

- [ ] **Step 4: Run tests**

Run: `npm run lint && npm test`
Expected: all pass (the upstream "retries on 500 errors" GET test still passes).

- [ ] **Step 5: Commit**

```bash
git add src/client/etsy-client.ts tests/unit/client/etsy-client.test.ts
git commit -m "fix: never auto-retry POST/PATCH after a server or network error" -m "A timed-out create_shipment or create_draft_listing could run twice." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Surface auth failures instead of swallowing them (F4)

**Files:**
- Modify: `src/utils/errors.ts`, `src/auth/oauth.ts` (refresh error only), `src/auth/auth-manager.ts` (full rewrite), `src/client/etsy-client.ts`
- Test: `tests/unit/auth/auth-manager.test.ts`, `tests/unit/auth/oauth.test.ts`, `tests/unit/client/etsy-client.test.ts` (append)

**Interfaces:**
- Produces:
  - `class EtsyAuthError extends Error` (message always mentions the `authenticate` tool)
  - `class TokenRefreshError extends Error { status: number; body: string; get isInvalidGrant(): boolean }`
  - `OAuthClient.refreshAccessToken` throws `TokenRefreshError` on a non-OK response
  - `AuthManager.getAccessToken(): Promise<string | null>` — `null` only when never signed in; throws `EtsyAuthError` when a refresh fails
  - `AuthManager.handleTokenExpired(): Promise<void>` — throws `EtsyAuthError` when there is no login or the refresh fails

- [ ] **Step 1: Write the failing tests**

In `tests/unit/auth/auth-manager.test.ts`, add to the imports:
```ts
import { EtsyAuthError, TokenRefreshError } from "../../../src/utils/errors.js";
```
and append inside `describe("AuthManager", ...)`:
```ts
  it("keeps the login and throws EtsyAuthError when a refresh fails for a network reason", async () => {
    await tokenStore.save({ access_token: "old", refresh_token: "r", expires_at: Date.now() - 1000 });
    (oauthClient.refreshAccessToken as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new TypeError("fetch failed"));

    await expect(manager.getAccessToken()).rejects.toThrow(EtsyAuthError);
    expect(tokenStore.clear).not.toHaveBeenCalled();
  });

  it("clears the login and asks to re-authenticate when the refresh token is dead", async () => {
    await tokenStore.save({ access_token: "old", refresh_token: "dead", expires_at: Date.now() - 1000 });
    (oauthClient.refreshAccessToken as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new TokenRefreshError(400, '{"error":"invalid_grant"}')
    );

    await expect(manager.getAccessToken()).rejects.toThrow("authenticate");
    expect(tokenStore.clear).toHaveBeenCalled();
  });

  it("handleTokenExpired without a login tells Claude to authenticate", async () => {
    await expect(manager.handleTokenExpired()).rejects.toThrow("authenticate");
  });

  it("authenticate starts a fresh login when the stored one is dead", async () => {
    await tokenStore.save({ access_token: "old", refresh_token: "dead", expires_at: Date.now() - 1000 });
    (oauthClient.refreshAccessToken as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new TokenRefreshError(400, '{"error":"invalid_grant"}')
    );

    await expect(manager.authenticate()).resolves.toBe("new-token");
    expect(oauthClient.startLocalAuthFlow).toHaveBeenCalled();
  });
```

In `tests/unit/auth/oauth.test.ts`, add to the imports:
```ts
import { TokenRefreshError } from "../../../src/utils/errors.js";
```
and append inside `describe("OAuthClient", ...)`:
```ts
  it("throws a TokenRefreshError that recognises invalid_grant", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: () => Promise.resolve('{"error":"invalid_grant","error_description":"expired"}'),
    }));

    const err = await client.refreshAccessToken("dead").catch((e: unknown) => e);

    expect(err).toBeInstanceOf(TokenRefreshError);
    expect((err as TokenRefreshError).isInvalidGrant).toBe(true);
    vi.unstubAllGlobals();
  });
```

In `tests/unit/client/etsy-client.test.ts`, add to the imports:
```ts
import { EtsyAuthError } from "../../../src/utils/errors.js";
```
and append inside `describe("EtsyClient", ...)`:
```ts
  it("passes auth errors through instead of retrying them", async () => {
    client = new EtsyClient({
      apiKey: "test-key",
      sharedSecret: "test-secret",
      getAccessToken: async () => null,
      onTokenExpired: async () => {
        throw new EtsyAuthError("This needs your Etsy login. Call the authenticate tool first.");
      },
    });
    mockFetch.mockResolvedValue({ ok: false, status: 401, json: () => Promise.resolve({}) });

    await expect(client.get("/shops/1/receipts")).rejects.toThrow(EtsyAuthError);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/auth tests/unit/client/etsy-client.test.ts`
Expected: FAIL — `EtsyAuthError` / `TokenRefreshError` are not exported from `errors.js`.

- [ ] **Step 3: Add the error types**

Append to `src/utils/errors.ts`:
```ts
/** A login problem Claude can fix by calling the authenticate tool. */
export class EtsyAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EtsyAuthError";
  }
}

export class TokenRefreshError extends Error {
  constructor(
    public status: number,
    public body: string
  ) {
    super(`Token refresh failed (${status}): ${body}`);
    this.name = "TokenRefreshError";
  }

  /** Etsy rejected the refresh token itself (expired after 90 days or revoked). */
  get isInvalidGrant(): boolean {
    return this.body.includes("invalid_grant");
  }
}
```

- [ ] **Step 4: Throw `TokenRefreshError` from `refreshAccessToken`**

In `src/auth/oauth.ts`, add after `import type { StoredTokens } from "./token-store.js";`:
```ts
import { TokenRefreshError } from "../utils/errors.js";
```
In `refreshAccessToken`, replace
```ts
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Token refresh failed (${response.status}): ${text}`);
    }
```
with
```ts
    if (!response.ok) {
      throw new TokenRefreshError(response.status, await response.text());
    }
```

- [ ] **Step 5: Rewrite `src/auth/auth-manager.ts`**

```ts
import type { TokenStore } from "./token-store.js";
import type { OAuthClient } from "./oauth.js";
import { EtsyAuthError, TokenRefreshError } from "../utils/errors.js";

const NOT_SIGNED_IN = "This needs your Etsy login. Call the authenticate tool first.";
const LOGIN_EXPIRED = "Your Etsy login has expired. Call the authenticate tool to sign in again.";

export class AuthManager {
  constructor(
    private tokenStore: TokenStore,
    private oauthClient: OAuthClient
  ) {}

  /** null means never signed in (public endpoints still work); a failed refresh throws EtsyAuthError. */
  async getAccessToken(): Promise<string | null> {
    const tokens = await this.tokenStore.load();
    if (!tokens) return null;

    if (!this.tokenStore.isAccessTokenExpired(tokens)) {
      return tokens.access_token;
    }
    return this.refresh(tokens.refresh_token);
  }

  async handleTokenExpired(): Promise<void> {
    const tokens = await this.tokenStore.load();
    if (!tokens) throw new EtsyAuthError(NOT_SIGNED_IN);
    await this.refresh(tokens.refresh_token);
  }

  async authenticate(): Promise<string> {
    try {
      const existing = await this.getAccessToken();
      if (existing) return existing;
    } catch (err) {
      if (!(err instanceof EtsyAuthError)) throw err;
      // Stored login is unusable: fall through to a fresh browser login.
    }

    const { code, redirectUri, codeVerifier } = await this.oauthClient.startLocalAuthFlow();
    const tokens = await this.oauthClient.exchangeCode(code, codeVerifier, redirectUri);
    await this.tokenStore.save(tokens);
    return tokens.access_token;
  }

  private async refresh(refreshToken: string): Promise<string> {
    try {
      const refreshed = await this.oauthClient.refreshAccessToken(refreshToken);
      await this.tokenStore.save(refreshed);
      return refreshed.access_token;
    } catch (err) {
      if (err instanceof TokenRefreshError && err.isInvalidGrant) {
        await this.tokenStore.clear();
        throw new EtsyAuthError(LOGIN_EXPIRED);
      }
      const reason = err instanceof Error ? err.message : String(err);
      throw new EtsyAuthError(`Could not refresh your Etsy login (${reason}). Try again, or call the authenticate tool.`);
    }
  }
}
```

- [ ] **Step 6: Let `EtsyAuthError` pass through the client**

In `src/client/etsy-client.ts`, replace
```ts
import { EtsyApiError } from "../utils/errors.js";
```
(the first line of the file) with
```ts
import { EtsyApiError, EtsyAuthError } from "../utils/errors.js";
```
and replace
```ts
        if (err instanceof EtsyApiError) throw err;
```
with
```ts
        if (err instanceof EtsyApiError || err instanceof EtsyAuthError) throw err;
```

- [ ] **Step 7: Run tests**

Run: `npm run lint && npm test`
Expected: all pass, including the 4 upstream AuthManager tests.

- [ ] **Step 8: Commit**

```bash
git add src/utils/errors.ts src/auth/oauth.ts src/auth/auth-manager.ts src/client/etsy-client.ts tests/unit/auth tests/unit/client/etsy-client.test.ts
git commit -m "fix: surface Etsy login failures and only drop tokens on invalid_grant" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Registered redirect URI, loopback-only callback, minimal scopes (F1, F2)

**Files:**
- Modify: `src/auth/oauth.ts` (full rewrite), `src/index.ts`
- Test: `tests/unit/auth/oauth-flow.test.ts` (create), `tests/unit/registry.test.ts` (append)

**Interfaces:**
- Consumes: `TokenRefreshError` (Task 7)
- Produces:
  - `DEFAULT_REDIRECT_PORT = 3003`, `REDIRECT_PATH = "/oauth/redirect"`, `CALLBACK_HOST = "127.0.0.1"`
  - `OAuthConfig.redirectPort?: number`, `OAuthConfig.openBrowser?: (url: string) => Promise<void>`
  - `OAuthClient.redirectUri(): string`
  - `ETSY_SCOPES: string[]` exported from `src/index.ts`; `ServerConfig.redirectPort?: number`

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/auth/oauth-flow.test.ts`:
```ts
import { describe, it, expect, vi, afterEach } from "vitest";
import net from "node:net";
import { OAuthClient } from "../../../src/auth/oauth.js";

function startFlow(port: number) {
  let markOpened!: (url: URL) => void;
  const opened = new Promise<URL>((resolve) => {
    markOpened = resolve;
  });
  const client = new OAuthClient({
    apiKey: "k",
    sharedSecret: "s",
    scopes: ["shops_r"],
    redirectPort: port,
    openBrowser: async (url) => markOpened(new URL(url)),
  });
  // Settle-safe wrapper so a rejection is never left unhandled while the test is still fetching.
  const outcome = client.startLocalAuthFlow().then(
    (value) => ({ value, error: null as Error | null }),
    (error: Error) => ({ value: null, error })
  );
  return { opened, outcome };
}

describe("OAuthClient local login", () => {
  afterEach(() => vi.restoreAllMocks());

  it("uses the registered redirect URI by default and honours a port override", () => {
    expect(new OAuthClient({ apiKey: "k", sharedSecret: "s", scopes: [] }).redirectUri())
      .toBe("http://localhost:3003/oauth/redirect");
    expect(new OAuthClient({ apiKey: "k", sharedSecret: "s", scopes: [], redirectPort: 4444 }).redirectUri())
      .toBe("http://localhost:4444/oauth/redirect");
  });

  it("listens on 127.0.0.1 only, ignores stray requests, and returns the code", async () => {
    const listen = vi.spyOn(net.Server.prototype, "listen");
    const { opened, outcome } = startFlow(38123);
    const authUrl = await opened;

    expect(listen.mock.calls[0]?.[1]).toBe("127.0.0.1");
    expect(authUrl.searchParams.get("redirect_uri")).toBe("http://localhost:38123/oauth/redirect");

    const stray = await fetch("http://127.0.0.1:38123/favicon.ico");
    expect(stray.status).toBe(404);

    const state = authUrl.searchParams.get("state");
    const callback = await fetch(`http://127.0.0.1:38123/oauth/redirect?code=abc&state=${state}`);
    expect(callback.status).toBe(200);

    const { value, error } = await outcome;
    expect(error).toBeNull();
    expect(value).toMatchObject({ code: "abc", redirectUri: "http://localhost:38123/oauth/redirect" });
  });

  it("rejects a callback with the wrong state", async () => {
    const { opened, outcome } = startFlow(38124);
    await opened;

    const callback = await fetch("http://127.0.0.1:38124/oauth/redirect?code=abc&state=wrong");
    expect(callback.status).toBe(403);

    const { error } = await outcome;
    expect(error?.message).toContain("state mismatch");
  });
});
```

In `tests/unit/registry.test.ts`, change the import line
```ts
import { createEtsyMcpServer } from "../../src/index.js";
```
to
```ts
import { createEtsyMcpServer, ETSY_SCOPES } from "../../src/index.js";
```
and append inside `describe("tool registry", ...)`:
```ts
  it("requests exactly the five scopes the tools need", () => {
    expect(ETSY_SCOPES).toEqual(["listings_r", "listings_w", "shops_r", "transactions_r", "transactions_w"]);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/auth/oauth-flow.test.ts tests/unit/registry.test.ts`
Expected: FAIL — `redirectUri is not a function`; `ETSY_SCOPES` is undefined.

- [ ] **Step 3: Rewrite `src/auth/oauth.ts`**

```ts
import { createHash, randomBytes } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import type { StoredTokens } from "./token-store.js";
import { TokenRefreshError } from "../utils/errors.js";

const ETSY_AUTH_URL = "https://www.etsy.com/oauth/connect";
const ETSY_TOKEN_URL = "https://api.etsy.com/v3/public/oauth/token";
const AUTH_TIMEOUT_MS = 120_000;

/** Etsy only accepts a redirect_uri that matches the app's registered callback URL exactly. */
export const DEFAULT_REDIRECT_PORT = 3003;
export const REDIRECT_PATH = "/oauth/redirect";
/** The callback server accepts connections from this machine only. */
export const CALLBACK_HOST = "127.0.0.1";

export interface OAuthConfig {
  apiKey: string;
  sharedSecret: string;
  scopes: string[];
  redirectPort?: number;
  /** Opens the consent page. Tests replace it so no real browser launches. */
  openBrowser?: (url: string) => Promise<void>;
}

async function openInDefaultBrowser(url: string): Promise<void> {
  const { default: open } = await import("open");
  await open(url);
}

function reply(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { "Content-Type": "text/html", Connection: "close" });
  res.end(`<html><body><h1>${message}</h1></body></html>`);
}

export class OAuthClient {
  private config: OAuthConfig;

  constructor(config: OAuthConfig) {
    this.config = config;
  }

  private get port(): number {
    return this.config.redirectPort ?? DEFAULT_REDIRECT_PORT;
  }

  redirectUri(): string {
    return `http://localhost:${this.port}${REDIRECT_PATH}`;
  }

  generateCodeVerifier(): string {
    return randomBytes(32).toString("base64url");
  }

  async generateCodeChallenge(verifier: string): Promise<string> {
    const hash = createHash("sha256").update(verifier).digest();
    return hash.toString("base64url");
  }

  async buildAuthorizationUrl(
    redirectUri: string
  ): Promise<{ url: string; codeVerifier: string; state: string }> {
    const codeVerifier = this.generateCodeVerifier();
    const codeChallenge = await this.generateCodeChallenge(codeVerifier);
    const state = randomBytes(16).toString("hex");

    const params = new URLSearchParams({
      response_type: "code",
      client_id: this.config.apiKey,
      redirect_uri: redirectUri,
      scope: this.config.scopes.join(" "),
      state,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
    });

    return {
      url: `${ETSY_AUTH_URL}?${params.toString().replace(/\+/g, "%20")}`,
      codeVerifier,
      state,
    };
  }

  async exchangeCode(
    code: string,
    codeVerifier: string,
    redirectUri: string
  ): Promise<StoredTokens> {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: this.config.apiKey,
      redirect_uri: redirectUri,
      code,
      code_verifier: codeVerifier,
    });

    const response = await fetch(ETSY_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Token exchange failed (${response.status}): ${text}`);
    }

    const data = (await response.json()) as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
    };

    return {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: Date.now() + data.expires_in * 1000,
    };
  }

  async refreshAccessToken(refreshToken: string): Promise<StoredTokens> {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: this.config.apiKey,
      refresh_token: refreshToken,
    });

    const response = await fetch(ETSY_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });

    if (!response.ok) {
      throw new TokenRefreshError(response.status, await response.text());
    }

    const data = (await response.json()) as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
    };

    return {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: Date.now() + data.expires_in * 1000,
    };
  }

  async startLocalAuthFlow(): Promise<{ code: string; redirectUri: string; codeVerifier: string }> {
    const redirectUri = this.redirectUri();
    const { url, codeVerifier, state } = await this.buildAuthorizationUrl(redirectUri);
    const openBrowser = this.config.openBrowser ?? openInDefaultBrowser;

    const code = await new Promise<string>((resolve, reject) => {
      const server = createServer((req, res) => {
        const callback = new URL(req.url ?? "/", "http://localhost");
        if (callback.pathname !== REDIRECT_PATH) {
          // Browsers also request /favicon.ico and the like; those must not end the login.
          res.writeHead(404, { Connection: "close" }).end();
          return;
        }

        const finish = (status: number, message: string, settle: () => void) => {
          reply(res, status, message);
          clearTimeout(timer);
          server.close();
          settle();
        };

        if (callback.searchParams.get("state") !== state) {
          finish(403, "State mismatch. Close this window and try again.", () =>
            reject(new Error("OAuth state mismatch: possible CSRF attack"))
          );
          return;
        }

        const returnedCode = callback.searchParams.get("code");
        if (!returnedCode) {
          const reason = callback.searchParams.get("error") ?? "no code returned";
          finish(400, "Authorization failed. You can close this window.", () =>
            reject(new Error(`Etsy authorization failed: ${reason}`))
          );
          return;
        }

        finish(200, "Authorization successful! You can close this window.", () => resolve(returnedCode));
      });

      const timer = setTimeout(() => {
        server.close();
        reject(new Error("OAuth flow timed out after 120 seconds"));
      }, AUTH_TIMEOUT_MS);

      server.on("error", (err: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        reject(
          err.code === "EADDRINUSE"
            ? new Error(`Port ${this.port} is busy. Close whatever is using it, or set ETSY_REDIRECT_PORT and register the matching callback URL on your Etsy app.`)
            : err
        );
      });

      server.listen(this.port, CALLBACK_HOST, () => {
        console.error(`\nOpen this URL to authorize:\n${url}\n`);
        openBrowser(url).catch(() => {
          // The URL is printed above, so the user can open it by hand.
        });
      });
    });

    return { code, redirectUri, codeVerifier };
  }
}
```

- [ ] **Step 4: Scopes and redirect port in `src/index.ts`**

Replace the whole `ALL_SCOPES` constant
```ts
const ALL_SCOPES = [
  "address_r", "address_w", "billing_r", "cart_r", "cart_w",
  "email_r", "favorites_r", "favorites_w", "feedback_r",
  "listings_d", "listings_r", "listings_w",
  "profile_r", "profile_w", "recommend_r", "recommend_w",
  "shops_r", "shops_w", "transactions_r", "transactions_w",
];
```
with
```ts
/** The minimum scopes the registered tools need, per the `security` blocks in Etsy's OpenAPI spec. */
export const ETSY_SCOPES = ["listings_r", "listings_w", "shops_r", "transactions_r", "transactions_w"];
```

In `interface ServerConfig`, add after `scopes?: string[];`:
```ts
  redirectPort?: number;
```

Replace
```ts
    scopes: config.scopes ?? ALL_SCOPES,
  });
```
with
```ts
    scopes: config.scopes ?? ETSY_SCOPES,
    redirectPort: config.redirectPort,
  });
```

In the CLI block, replace
```ts
  const server = createEtsyMcpServer({ apiKey, sharedSecret });
```
with
```ts
  const portSetting = process.env.ETSY_REDIRECT_PORT;
  const redirectPort = portSetting ? Number(portSetting) : undefined;
  if (redirectPort !== undefined && !(Number.isInteger(redirectPort) && redirectPort > 0 && redirectPort < 65536)) {
    console.error("Error: ETSY_REDIRECT_PORT must be a port number between 1 and 65535.");
    process.exit(1);
  }

  const server = createEtsyMcpServer({ apiKey, sharedSecret, redirectPort });
```

- [ ] **Step 5: Run tests**

Run: `npm run lint && npm test`
Expected: all pass (upstream `oauth.test.ts` "builds a correct authorization URL" still passes — it passes its own redirect URI).

- [ ] **Step 6: Commit**

```bash
git add src/auth/oauth.ts src/index.ts tests/unit/auth/oauth-flow.test.ts tests/unit/registry.test.ts
git commit -m "fix: use the registered redirect URI, loopback-only callback, five scopes" -m "Upstream listened on a random port, so the redirect_uri could never match the URL registered on the Etsy app." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Load keys from `~/.etsy-mcp/.env`, quietly (F6)

**Files:**
- Create: `src/env.ts`
- Test: `tests/unit/env.test.ts`
- Modify: `src/index.ts` (full final version below)

**Interfaces:**
- Produces: `etsyEnvPath(home?: string): string`, `loadEnvFile(path?: string): void`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/env.test.ts`:
```ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { etsyEnvPath, loadEnvFile } from "../../src/env.js";

function envFile(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "etsy-env-"));
  const path = join(dir, ".env");
  writeFileSync(path, contents);
  return path;
}

describe("env loading", () => {
  afterEach(() => {
    delete process.env.ETSY_ENV_TEST_A;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("keeps keys beside the tokens in ~/.etsy-mcp", () => {
    expect(etsyEnvPath("/home/devin")).toBe(join("/home/devin", ".etsy-mcp", ".env"));
  });

  it("loads values from the file without overriding real env vars", () => {
    vi.stubEnv("ETSY_ENV_TEST_B", "from-shell");
    loadEnvFile(envFile("ETSY_ENV_TEST_A=from-file\nETSY_ENV_TEST_B=from-file\n"));
    expect(process.env.ETSY_ENV_TEST_A).toBe("from-file");
    expect(process.env.ETSY_ENV_TEST_B).toBe("from-shell");
  });

  it("never prints to stdout, which would corrupt the MCP stdio stream", () => {
    const log = vi.spyOn(console, "log");
    const write = vi.spyOn(process.stdout, "write");
    loadEnvFile(envFile("ETSY_ENV_TEST_A=x\n"));
    loadEnvFile(join(tmpdir(), "does-not-exist", ".env"));
    expect(log).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/env.test.ts`
Expected: FAIL — cannot resolve `../../src/env.js`.

- [ ] **Step 3: Implement `src/env.ts`**

```ts
import { config as loadDotenv } from "dotenv";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Keys live beside the OAuth tokens in ~/.etsy-mcp, not in the project folder:
 * D:\PROJECTS is mirrored to the VPS by Syncthing, .env files included.
 */
export function etsyEnvPath(home: string = homedir()): string {
  return join(home, ".etsy-mcp", ".env");
}

/** Real env vars win. quiet: dotenv 17 otherwise logs to stdout, which corrupts the MCP stdio stream. */
export function loadEnvFile(path: string = etsyEnvPath()): void {
  loadDotenv({ path, quiet: true });
}
```

- [ ] **Step 4: Final `src/index.ts`**

Replace the whole file with:
```ts
#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { TokenStore } from "./auth/token-store.js";
import { OAuthClient } from "./auth/oauth.js";
import { AuthManager } from "./auth/auth-manager.js";
import { EtsyClient } from "./client/etsy-client.js";
import { ShopContext } from "./client/shop-context.js";
import { READ } from "./tools/annotations.js";
import { registerListingsTools } from "./tools/listings.js";
import { registerShopTools } from "./tools/shop.js";
import { registerOrdersTools } from "./tools/orders.js";
import { registerTransactionsTools } from "./tools/transactions.js";
import { registerReviewsTools } from "./tools/reviews.js";
import { registerTaxonomyTools } from "./tools/taxonomy.js";
import { registerImagesTools } from "./tools/images.js";
import { registerInventoryTools } from "./tools/inventory.js";
import { registerPaymentsTools } from "./tools/payments.js";
import { registerStatsTools } from "./tools/stats.js";
import { etsyEnvPath, loadEnvFile } from "./env.js";
import { join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

/** The minimum scopes the registered tools need, per the `security` blocks in Etsy's OpenAPI spec. */
export const ETSY_SCOPES = ["listings_r", "listings_w", "shops_r", "transactions_r", "transactions_w"];

export interface ServerConfig {
  apiKey: string;
  sharedSecret: string;
  tokenStorePath?: string;
  scopes?: string[];
  redirectPort?: number;
}

export function createEtsyMcpServer(config: ServerConfig): McpServer {
  const server = new McpServer({
    name: "etsy-mcp",
    version: "1.0.0",
  });

  const tokenStorePath =
    config.tokenStorePath ?? join(homedir(), ".etsy-mcp", "tokens.json");

  const tokenStore = new TokenStore(tokenStorePath);
  const oauthClient = new OAuthClient({
    apiKey: config.apiKey,
    sharedSecret: config.sharedSecret,
    scopes: config.scopes ?? ETSY_SCOPES,
    redirectPort: config.redirectPort,
  });
  const authManager = new AuthManager(tokenStore, oauthClient);

  const client = new EtsyClient({
    apiKey: config.apiKey,
    sharedSecret: config.sharedSecret,
    getAccessToken: () => authManager.getAccessToken(),
    onTokenExpired: () => authManager.handleTokenExpired(),
  });

  server.registerTool(
    "authenticate",
    {
      description: "Authenticate with Etsy via OAuth 2.0. Opens a browser for consent. Required before using tools that need user authorization.",
      annotations: READ,
    },
    async () => {
      const token = await authManager.authenticate();
      return {
        content: [{
          type: "text" as const,
          text: token ? "Successfully authenticated with Etsy!" : "Authentication failed.",
        }],
      };
    }
  );

  const shop = new ShopContext(client);

  registerListingsTools(server, client, shop);
  registerShopTools(server, client, shop);
  registerOrdersTools(server, client, shop);
  registerTransactionsTools(server, client, shop);
  registerReviewsTools(server, client, shop);
  registerTaxonomyTools(server, client);
  registerImagesTools(server, client, shop);
  registerInventoryTools(server, client);
  registerPaymentsTools(server, client, shop);
  registerStatsTools(server, client, shop);

  return server;
}

// CLI entry point - only run when executed directly
const currentFile = fileURLToPath(import.meta.url);
const isDirectRun = process.argv[1] && currentFile === process.argv[1];

if (isDirectRun) {
  loadEnvFile();
  const apiKey = process.env.ETSY_API_KEY;
  const sharedSecret = process.env.ETSY_SHARED_SECRET;

  if (!apiKey || !sharedSecret) {
    console.error("Error: ETSY_API_KEY and ETSY_SHARED_SECRET are required.");
    console.error(`Put them in ${etsyEnvPath()} (see .env.example) or set them as environment variables.`);
    process.exit(1);
  }

  const portSetting = process.env.ETSY_REDIRECT_PORT;
  const redirectPort = portSetting ? Number(portSetting) : undefined;
  if (redirectPort !== undefined && !(Number.isInteger(redirectPort) && redirectPort > 0 && redirectPort < 65536)) {
    console.error("Error: ETSY_REDIRECT_PORT must be a port number between 1 and 65535.");
    process.exit(1);
  }

  const server = createEtsyMcpServer({ apiKey, sharedSecret, redirectPort });
  const transport = new StdioServerTransport();
  server.connect(transport).catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}
```

- [ ] **Step 5: Run tests**

Run: `npm run lint && npm test`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/env.ts src/index.ts tests/unit/env.test.ts
git commit -m "fix: load keys quietly from ~/.etsy-mcp/.env" -m "dotenv/config read .env from the launch cwd (never the project when Claude starts the server) and dotenv 17 logs to stdout, which corrupts stdio. ~/.etsy-mcp also keeps keys out of the Syncthing-mirrored project tree." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Housekeeping, docs, stdio smoke script

**Files:**
- Delete: `Dockerfile`, `.github/workflows/docker-publish.yml`
- Modify: `.env.example`, `package.json`, `src/index.ts` (version line), `tests/integration/ping.test.ts`, `README.md` (full rewrite)
- Create: `scripts/smoke-stdio.mjs`

**Interfaces:**
- Consumes: built `dist/index.js` (33 tools)
- Produces: `npm run smoke`

- [ ] **Step 1: Delete the Docker bits**

```bash
git rm Dockerfile .github/workflows/docker-publish.yml
```

- [ ] **Step 2: Replace `.env.example`**

```
# Copy to ~/.etsy-mcp/.env (C:\Users\<you>\.etsy-mcp\.env on Windows), not into this folder.
# Values come from etsy.com/developers -> Your apps.
ETSY_API_KEY=your_keystring
ETSY_SHARED_SECRET=your_shared_secret

# Optional. Your Etsy app's callback URL must be exactly
# http://localhost:<port>/oauth/redirect   (default port 3003)
# ETSY_REDIRECT_PORT=3003
```

- [ ] **Step 3: Fix the integration ping header**

Replace the body of the test in `tests/integration/ping.test.ts` with:
```ts
  it("can reach the Etsy API ping endpoint", async () => {
    const apiKey = process.env.ETSY_API_KEY;
    const sharedSecret = process.env.ETSY_SHARED_SECRET;
    if (!apiKey || !sharedSecret) {
      console.error("Skipping integration test: ETSY_API_KEY / ETSY_SHARED_SECRET not set");
      return;
    }

    const response = await fetch(
      "https://openapi.etsy.com/v3/application/openapi-ping",
      { headers: { "x-api-key": `${apiKey}:${sharedSecret}` } }
    );

    expect(response.ok).toBe(true);
    const data = await response.json();
    expect(data).toHaveProperty("application_id");
  });
```

- [ ] **Step 4: Version and smoke script in `package.json`**

Change `"version": "1.0.0",` to `"version": "1.1.0-elektron",`.
Add after the `"author": "Amit Serper",` line:
```json
  "contributors": [
    "Elektron Labs (https://elektronlabs.net)"
  ],
```
Add to `"scripts"` after `"lint": "tsc --noEmit",`:
```json
    "smoke": "node scripts/smoke-stdio.mjs",
```
In `src/index.ts`, change `version: "1.0.0",` to `version: "1.1.0-elektron",`.

- [ ] **Step 5: Create `scripts/smoke-stdio.mjs`**

```js
// Starts the built server over stdio the way Claude does, from an unrelated folder,
// and checks it answers with the expected tool list. Usage: npm run build && npm run smoke
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const EXPECTED_TOOLS = 33;
const entry = fileURLToPath(new URL("../dist/index.js", import.meta.url));

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [entry],
  cwd: tmpdir(),
  env: { ...process.env, ETSY_API_KEY: "smoke-key", ETSY_SHARED_SECRET: "smoke-secret" },
  stderr: "inherit",
});
const client = new Client({ name: "smoke", version: "0.0.0" });
await client.connect(transport);
const { tools } = await client.listTools();
await client.close();

if (tools.length !== EXPECTED_TOOLS) {
  console.error(`FAIL: expected ${EXPECTED_TOOLS} tools, got ${tools.length}`);
  process.exit(1);
}
console.log(`OK: started over stdio from ${tmpdir()} and listed ${tools.length} tools`);
```

- [ ] **Step 6: Rewrite `README.md`**

````markdown
# Etsy MCP Server (Elektron Labs fork)

A hardened, trimmed fork of [aserper/etsy-mcp](https://github.com/aserper/etsy-mcp) by Amit Serper. It lets Claude Code and Claude Desktop run one Etsy shop: orders and shipping, listings and inventory, sales stats, and market research.

## What this fork changes

- **Login works.** The OAuth callback is fixed at `http://localhost:3003/oauth/redirect`, which is what Etsy requires (an exact match with the URL registered on your app). It listens on 127.0.0.1 only.
- **Least privilege.** Requests `listings_r listings_w shops_r transactions_r transactions_w` instead of all 20 scopes.
- **No duplicate writes.** POST and PATCH are never retried after a server error or dropped connection.
- **Clear login errors.** An expired or failed login tells Claude to call `authenticate` instead of failing silently.
- **Upload guard.** Image and video upload only read image and video files.
- **Keys outside the project.** Keys load from `~/.etsy-mcp/.env`, next to the tokens. Nothing is printed to stdout.
- **33 tools for one seller.** Shop-admin tools are gone. `get_unshipped_orders` and `get_sales_summary` are new. `shop_id` defaults to your shop. Every tool is marked read-only or write, so clients can ask before writes.

## Tools

| Area | Read | Write |
|---|---|---|
| Orders | `get_unshipped_orders`, `get_shop_receipts`, `get_receipt`, `get_shipping_carriers` | `create_shipment`, `update_receipt` |
| Transactions | `get_transactions_by_shop`, `get_transaction`, `get_transactions_by_receipt` | |
| Listings | `search_listings`, `get_listing`, `get_listings_by_shop` | `create_draft_listing`, `update_listing` |
| Inventory | `get_listing_inventory` | `update_listing_inventory` |
| Images | `get_listing_images` | `upload_listing_image`, `upload_listing_video`, `delete_listing_image` |
| Shop | `get_me`, `get_shop`, `find_shops`, `get_shop_sections`, `get_shipping_profiles` | |
| Reviews | `get_reviews_by_listing`, `get_reviews_by_shop` | |
| Taxonomy | `get_buyer_taxonomy`, `get_taxonomy_properties` | |
| Money | `get_sales_summary`, `get_payments`, `get_ledger_entries` | |
| Auth | `authenticate` | |

## Setup

1. Create an app at [etsy.com/developers/your-apps](https://www.etsy.com/developers/your-apps). Set its callback URL to exactly `http://localhost:3003/oauth/redirect`.
2. Create `~/.etsy-mcp/.env` (on Windows, `C:\Users\<you>\.etsy-mcp\.env`) from `.env.example`. Real environment variables take precedence over the file.
3. Build: `npm install && npm run build`
4. Register the server:
   - Claude Code: `claude mcp add etsy -s user -- node /absolute/path/to/etsy-mcp/dist/index.js`
   - Claude Desktop, in `claude_desktop_config.json`:
     ```json
     { "mcpServers": { "etsy": { "command": "node", "args": ["/absolute/path/to/etsy-mcp/dist/index.js"] } } }
     ```
5. Ask Claude to authenticate with Etsy. Your browser opens Etsy's consent page. Tokens are saved to `~/.etsy-mcp/tokens.json` and refreshed automatically. The refresh token lasts 90 days; after that, authenticate again.

To use a different callback port, set `ETSY_REDIRECT_PORT` and register the matching URL on your Etsy app.

## Development

```bash
npm install          # install dependencies
npm run build        # compile TypeScript to dist/
npm test             # unit tests
npm run lint         # type check
npm run smoke        # start dist/index.js over stdio and check the tool list
npm run generate-types  # regenerate types from Etsy's OpenAPI spec
```

## Limits

Etsy's Open API v3 has no buyer messaging, cart, favorites or checkout endpoints, so this server can't do those things.

## License

MIT. See [LICENSE](LICENSE). Original project by Amit Serper.

## Disclaimer

This project is not affiliated with, endorsed by, or associated with Etsy, Inc. It uses Etsy's publicly available Open API v3. Use it responsibly and in line with [Etsy's API Terms of Use](https://www.etsy.com/legal/api).
````

- [ ] **Step 7: Build and run the smoke test**

Run: `npm run lint && npm test && npm run build && npm run smoke`
Expected: lint clean; all tests pass; `OK: started over stdio from <tmp> and listed 33 tools`.

- [ ] **Step 8: Commit**

```bash
git add -A
git status --short   # confirm: no .env, no dist/, no node_modules staged
git commit -m "docs: fork README, env example, stdio smoke script; drop Docker" -m "Also fixes the integration ping test to send keystring:shared_secret." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Final verification, then push and PR (gated)

- [ ] **Step 1: Clean-install verification**

Run:
```bash
cd D:/PROJECTS/etsy-mcp && npm ci --no-audit --no-fund && npm run lint && npm test && npm run build && npm run smoke
```
Expected: `npm ci` succeeds (lockfile synced in Task 1); lint clean; all tests pass; smoke prints `listed 33 tools`.

- [ ] **Step 2: Spec coverage check**

Run: `git diff --stat main...HEAD` and confirm each spec item maps to a commit: F1+F2 (Task 8), F3 (Task 6), F4 (Task 7), F5 (Task 5), F6 (Task 9), tool surface (Tasks 2–4), housekeeping (Task 10).

- [ ] **Step 3: STOP — ask Devin before anything leaves the machine**

Ask: "All green. Push `feat/elektron-fork` and open a PR to `main` on elektronlabs/etsy-mcp?" Wait for an explicit yes.

- [ ] **Step 4: Push and open the PR (only after yes)**

```bash
gh repo set-default elektronlabs/etsy-mcp
git push -u origin feat/elektron-fork
gh pr create --repo elektronlabs/etsy-mcp --base main --head feat/elektron-fork \
  --title "Elektron Labs fork: hardened 33-tool Etsy MCP" \
  --body-file - <<'EOF'
Implements docs/superpowers/specs/2026-10-17-elektron-fork-design.md.

- Fixes: registered OAuth redirect + loopback-only callback, 5 scopes, no POST/PATCH auto-retry, surfaced auth errors, upload path guard, quiet ~/.etsy-mcp/.env loading
- Tools: 41 -> 33; adds get_unshipped_orders and get_sales_summary; shop_id defaults to your shop; read/write annotations
- Docs: fork README, .env.example, stdio smoke script; Docker removed

Verified: npm ci, lint, unit tests, build, `npm run smoke` (33 tools over stdio).

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
```
`--repo` matters: in a fork, `gh pr create` otherwise targets the upstream repo.

---

### Task 12: Devin's setup and live read-only smoke (interactive, gated)

Claude never handles the Etsy keys: Devin types them into the file. Every config change below needs Devin's OK at the time.

- [ ] **Step 1 (Devin): Create the Etsy app**

etsy.com/developers → Create a new app (personal access). Callback URL: `http://localhost:3003/oauth/redirect`.

- [ ] **Step 2 (Devin): Create `C:\Users\Devin\.etsy-mcp\.env`**

Copy `.env.example`'s first block and fill in the keystring and shared secret.

- [ ] **Step 3: Register with Claude Code (after Devin's OK)**

```bash
claude mcp add etsy -s user -- node D:/PROJECTS/etsy-mcp/dist/index.js
claude mcp list
```
Expected: `etsy` listed as connected.

- [ ] **Step 4: Register with Claude Desktop (after Devin's OK)**

Open Claude Desktop → Settings → Developer → Edit Config. Back up the file, then add under `mcpServers`:
```json
"etsy": { "command": "node", "args": ["D:\\PROJECTS\\etsy-mcp\\dist\\index.js"] }
```
Restart Claude Desktop; confirm `etsy` shows 33 tools.

- [ ] **Step 5: Allow-list the 25 read tools in Claude Code (after Devin's OK)**

Using the update-config skill, add these to `permissions.allow` in `~/.claude/settings.json`, leaving the 8 write tools unlisted so each write prompts:
```
mcp__etsy__authenticate, mcp__etsy__find_shops, mcp__etsy__get_buyer_taxonomy, mcp__etsy__get_ledger_entries,
mcp__etsy__get_listing, mcp__etsy__get_listing_images, mcp__etsy__get_listing_inventory, mcp__etsy__get_listings_by_shop,
mcp__etsy__get_me, mcp__etsy__get_payments, mcp__etsy__get_receipt, mcp__etsy__get_reviews_by_listing,
mcp__etsy__get_reviews_by_shop, mcp__etsy__get_sales_summary, mcp__etsy__get_shipping_carriers,
mcp__etsy__get_shipping_profiles, mcp__etsy__get_shop, mcp__etsy__get_shop_receipts, mcp__etsy__get_shop_sections,
mcp__etsy__get_taxonomy_properties, mcp__etsy__get_transaction, mcp__etsy__get_transactions_by_receipt,
mcp__etsy__get_transactions_by_shop, mcp__etsy__get_unshipped_orders, mcp__etsy__search_listings
```

- [ ] **Step 6: Live read-only smoke (new Claude Code session so the server loads)**

Call, in order: `authenticate` (Devin approves in the browser) → `get_me` → `get_shop` → `get_unshipped_orders` → `get_sales_summary` for the last 30 days → `search_listings` with a niche keyword Devin picks. Each must return data, not an error. If the browser can't reach the callback, check that nothing else holds port 3003. No write tools during this step.

- [ ] **Step 7: Record it**

Update Claude's memory with a `project` note: Etsy MCP lives at `D:\PROJECTS\etsy-mcp` (fork `elektronlabs/etsy-mcp`), keys and tokens in `~/.etsy-mcp/`, registered as `etsy` in Claude Code (user scope) and Claude Desktop, reads allow-listed and writes prompt.
