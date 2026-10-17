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
