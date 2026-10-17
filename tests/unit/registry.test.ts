import { describe, it, expect, vi, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEtsyMcpServer, ETSY_SCOPES } from "../../src/index.js";
import { connectClient, textOf } from "../helpers/mcp.js";

const READS = [
  "find_shops", "get_buyer_taxonomy", "get_ledger_entries", "get_listing",
  "get_listing_images", "get_listing_inventory", "get_listings_by_shop", "get_me", "get_payments",
  "get_receipt", "get_reviews_by_listing", "get_reviews_by_shop", "get_sales_summary", "get_shipping_carriers", "get_unshipped_orders",
  "get_shipping_profiles", "get_shop", "get_shop_receipts", "get_shop_sections",
  "get_taxonomy_properties", "get_transaction", "get_transactions_by_receipt",
  "get_transactions_by_shop", "search_listings",
];
const ADDITIVE_WRITES = ["create_draft_listing", "create_shipment", "upload_listing_image", "upload_listing_video"];
const DESTRUCTIVE_WRITES = ["delete_listing_image", "update_listing", "update_listing_inventory", "update_receipt"];
const SIGN_IN_TOOLS = ["authenticate"];

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
    expect(names).toEqual([...READS, ...ADDITIVE_WRITES, ...DESTRUCTIVE_WRITES, ...SIGN_IN_TOOLS].sort());
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

  it("marks authenticate as a non-destructive local write", async () => {
    const tool = (await listTools()).find((t) => t.name === "authenticate");
    expect(tool?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, openWorldHint: true });
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

  describe("input schemas match Etsy's OpenAPI spec", () => {
    type Schema = { properties?: Record<string, { enum?: string[]; minimum?: number; maximum?: number; type?: string }>; required?: string[] };
    async function schemaOf(name: string): Promise<Schema> {
      const tool = (await listTools()).find((t) => t.name === name);
      expect(tool, name).toBeDefined();
      return tool!.inputSchema as Schema;
    }

    it("update_listing accepts only fields Etsy's updateListing takes", async () => {
      const schema = await schemaOf("update_listing");
      expect(schema.properties).not.toHaveProperty("price");
      expect(schema.properties).not.toHaveProperty("quantity");
      expect(schema.properties?.state?.enum).toEqual(["active", "inactive"]);
    });

    it("update_listing refuses price instead of silently sending an empty update", async () => {
      const paths = stubEtsy(777);
      const client = await connectClient(makeServer());
      const result = await client.callTool({ name: "update_listing", arguments: { shop_id: 5, listing_id: 9, price: 10 } });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("price");
      expect(paths()).toEqual([]);
    });

    it("update_listing says where price and quantity changes go", async () => {
      const tool = (await listTools()).find((t) => t.name === "update_listing");
      expect(tool?.description).toContain("update_listing_inventory");
      expect(tool?.description).toContain("inactive");
    });

    it("get_payments requires receipt_id", async () => {
      expect((await schemaOf("get_payments")).required).toContain("receipt_id");
    });

    it("get_ledger_entries requires min_created and max_created as integers", async () => {
      const schema = await schemaOf("get_ledger_entries");
      expect(schema.required).toEqual(expect.arrayContaining(["min_created", "max_created"]));
      expect(schema.properties?.min_created?.type).toBe("integer");
      expect(schema.properties?.max_created?.type).toBe("integer");
    });

    it("create_draft_listing offers Etsy's current when_made values", async () => {
      const values = (await schemaOf("create_draft_listing")).properties?.when_made?.enum;
      expect(values).toEqual([
        "made_to_order", "2020_2026", "2010_2019", "2007_2009", "before_2007", "2000_2006",
        "1990s", "1980s", "1970s", "1960s", "1950s", "1940s", "1930s", "1920s", "1910s", "1900s",
        "1800s", "1700s", "before_1700",
      ]);
    });
  });

  describe("paging inputs", () => {
    const PAGED = [
      "find_shops", "get_listings_by_shop", "search_listings", "get_shop_receipts", "get_unshipped_orders",
      "get_transactions_by_shop", "get_reviews_by_listing", "get_reviews_by_shop", "get_ledger_entries",
    ];

    it("bounds limit to 1-100 whole numbers and offset to whole numbers from 0 on every paged tool", async () => {
      const tools = await listTools();
      for (const name of PAGED) {
        const props = (tools.find((t) => t.name === name)?.inputSchema as { properties: Record<string, { type?: string; minimum?: number; maximum?: number }> }).properties;
        expect(props.limit, name).toMatchObject({ type: "integer", minimum: 1, maximum: 100 });
        expect(props.offset, name).toMatchObject({ type: "integer", minimum: 0 });
      }
    });

    it("rejects a limit of 0 or a fractional offset before calling Etsy", async () => {
      const paths = stubEtsy(777);
      const client = await connectClient(makeServer());
      const zero = await client.callTool({ name: "get_shop_receipts", arguments: { shop_id: 5, limit: 0 } });
      const fraction = await client.callTool({ name: "get_shop_receipts", arguments: { shop_id: 5, offset: 1.5 } });
      expect(zero.isError).toBe(true);
      expect(fraction.isError).toBe(true);
      expect(paths()).toEqual([]);
    });
  });

  it("requests exactly the five scopes the tools need", () => {
    expect(ETSY_SCOPES).toEqual(["listings_r", "listings_w", "shops_r", "transactions_r", "transactions_w"]);
  });
});
