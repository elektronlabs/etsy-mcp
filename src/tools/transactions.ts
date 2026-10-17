import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { EtsyClient } from "../client/etsy-client.js";
import type { ShopContext } from "../client/shop-context.js";
import { paginationParams, formatPaginatedResponse } from "../utils/pagination.js";
import { READ } from "./annotations.js";
import { limitArg, offsetArg, shopIdArg } from "./args.js";

export function registerTransactionsTools(server: McpServer, client: EtsyClient, shop: ShopContext): void {
  server.registerTool("get_transactions_by_shop", {
    description: "Get all transactions for a shop",
    inputSchema: {
      shop_id: shopIdArg,
      limit: limitArg,
      offset: offsetArg,
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
