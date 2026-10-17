import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { EtsyClient } from "../client/etsy-client.js";
import type { ShopContext } from "../client/shop-context.js";
import { paginationParams, formatPaginatedResponse } from "../utils/pagination.js";
import { READ } from "./annotations.js";
import { limitArg, offsetArg, shopIdArg } from "./args.js";

export function registerPaymentsTools(server: McpServer, client: EtsyClient, shop: ShopContext): void {
  server.registerTool("get_payments", {
    description: "Get the payment for one receipt (order): amounts, fees and when funds posted. Etsy only exposes payments per receipt, so find the receipt_id with get_shop_receipts first (read-only)",
    inputSchema: {
      shop_id: shopIdArg,
      receipt_id: z.number().describe("Receipt (order) ID to fetch the payment for"),
    },
    annotations: READ,
  }, async (args) => {
    const shopId = await shop.resolve(args.shop_id);
    const data = await client.get(`/shops/${shopId}/receipts/${args.receipt_id}/payments`);
    return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
  });

  server.registerTool("get_ledger_entries", {
    description: "Get payment account ledger entries for a shop (fees, payouts) created between min_created and max_created. Etsy requires both bounds",
    inputSchema: {
      shop_id: shopIdArg,
      min_created: z.number().int().describe("Earliest creation time, Unix epoch seconds (required)"),
      max_created: z.number().int().describe("Latest creation time, Unix epoch seconds (required)"),
      limit: limitArg,
      offset: offsetArg,
    },
    annotations: READ,
  }, async (args) => {
    const shopId = await shop.resolve(args.shop_id);
    const params: Record<string, string> = {
      ...paginationParams({ limit: args.limit, offset: args.offset }),
      min_created: String(args.min_created),
      max_created: String(args.max_created),
    };
    const data = await client.get<{ count: number; results: unknown[] }>(`/shops/${shopId}/payment-account/ledger-entries`, params);
    return { content: [{ type: "text" as const, text: formatPaginatedResponse(data, args.limit ?? 25, args.offset ?? 0) }] };
  });
}
