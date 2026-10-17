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
