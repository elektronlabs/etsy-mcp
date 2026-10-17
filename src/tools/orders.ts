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
