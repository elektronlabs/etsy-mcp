import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { EtsyClient } from "../client/etsy-client.js";
import type { ShopContext } from "../client/shop-context.js";
import { paginationParams, formatPaginatedResponse } from "../utils/pagination.js";
import { READ } from "./annotations.js";
import { limitArg, offsetArg, shopIdArg } from "./args.js";

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
      limit: limitArg,
      offset: offsetArg,
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
