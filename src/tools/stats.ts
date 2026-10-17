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

/** Date.parse rolls impossible days over (2026-02-30 becomes March 2); a real day round-trips to the same text. */
function isRealDay(epochSeconds: number, date: string): boolean {
  return !Number.isNaN(epochSeconds) && new Date(epochSeconds * 1000).toISOString().slice(0, 10) === date;
}

/** Inclusive range of whole UTC days, as epoch seconds. */
export function dayRangeUtc(startDate: string, endDate: string): { min: number; max: number } {
  const min = Date.parse(`${startDate}T00:00:00Z`) / 1000;
  const max = Date.parse(`${endDate}T23:59:59Z`) / 1000;
  if (!isRealDay(min, startDate) || !isRealDay(max, endDate)) {
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
  // Etsy writes the status capitalized ("Fully Refunded"); compare without case.
  const counted = receipts.filter((receipt) => receipt.status.toLowerCase() !== "fully refunded");

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
      "Canceled and fully refunded orders are excluded. " +
      "top_listings.revenue is price x quantity before coupon discounts, while item_subtotal is after them, so the two can differ. " +
      "Totals cover at most 2,000 receipts (truncated is true when more exist). " +
      "Slow movers are drawn from the oldest 500 active listings.",
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
