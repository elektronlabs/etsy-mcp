import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { EtsyClient } from "../client/etsy-client.js";
import type { ShopContext } from "../client/shop-context.js";
import { paginationParams, formatPaginatedResponse } from "../utils/pagination.js";
import { READ } from "./annotations.js";
import { limitArg, offsetArg, shopIdArg } from "./args.js";

export function registerReviewsTools(server: McpServer, client: EtsyClient, shop: ShopContext): void {
  server.registerTool("get_reviews_by_listing", {
    description: "Get reviews for a specific listing",
    inputSchema: {
      listing_id: z.number().describe("The listing ID"),
      limit: limitArg,
      offset: offsetArg,
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
      limit: limitArg,
      offset: offsetArg,
    },
    annotations: READ,
  }, async (args) => {
    const shopId = await shop.resolve(args.shop_id);
    const params = paginationParams({ limit: args.limit, offset: args.offset });
    const data = await client.get<{ count: number; results: unknown[] }>(`/shops/${shopId}/reviews`, params);
    return { content: [{ type: "text" as const, text: formatPaginatedResponse(data, args.limit ?? 25, args.offset ?? 0) }] };
  });
}
