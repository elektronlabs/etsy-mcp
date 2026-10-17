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
