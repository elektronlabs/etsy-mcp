import { describe, it, expect, vi } from "vitest";
import { buildSalesSummary, dayRangeUtc, MAX_RECEIPTS } from "../../../src/tools/stats.js";

type Page = { count: number; results: unknown[] };
const usd = (amount: number) => ({ amount, divisor: 100, currency_code: "USD" });

function fakeEtsy(receiptPages: Page[], listingPages: Page[]) {
  let r = 0;
  let l = 0;
  const get = vi.fn(async (path: string) => {
    if (path.endsWith("/receipts")) return receiptPages[r++] ?? { count: 0, results: [] };
    if (path.endsWith("/listings")) return listingPages[l++] ?? { count: 0, results: [] };
    throw new Error(`unexpected path ${path}`);
  });
  return { get };
}

describe("dayRangeUtc", () => {
  it("covers whole UTC days, inclusive", () => {
    expect(dayRangeUtc("2026-09-01", "2026-09-30")).toEqual({
      min: Date.UTC(2026, 8, 1) / 1000,
      max: Date.UTC(2026, 8, 30, 23, 59, 59) / 1000,
    });
  });

  it("rejects bad or reversed dates", () => {
    expect(() => dayRangeUtc("2026-13-01", "2026-12-01")).toThrow("Invalid date");
    expect(() => dayRangeUtc("2026-09-30", "2026-09-01")).toThrow("on or before");
  });

  it("rejects calendar days that don't exist", () => {
    expect(() => dayRangeUtc("2026-09-01", "2026-09-31")).toThrow("Invalid date");
    expect(() => dayRangeUtc("2026-02-30", "2026-03-01")).toThrow("Invalid date");
  });
});

describe("buildSalesSummary", () => {
  it("totals non-refunded orders, ranks listings, and finds slow movers", async () => {
    const etsy = fakeEtsy(
      [{
        count: 3,
        results: [
          { status: "paid", grandtotal: usd(2599), subtotal: usd(2000), transactions: [{ listing_id: 10, title: "Mug", quantity: 2, price: usd(1000) }] },
          { status: "completed", grandtotal: usd(1550), subtotal: usd(1200), transactions: [{ listing_id: 20, title: "Print", quantity: 1, price: usd(1200) }] },
          { status: "fully refunded", grandtotal: usd(5000), subtotal: usd(5000), transactions: [{ listing_id: 30, title: "Lamp", quantity: 1, price: usd(5000) }] },
        ],
      }],
      [{
        count: 3,
        results: [
          { listing_id: 10, title: "Mug", created_timestamp: 1700000000 },
          { listing_id: 40, title: "Old sticker", created_timestamp: 1600000000 },
          { listing_id: 30, title: "Lamp", created_timestamp: 1650000000 },
        ],
      }],
    );

    const summary = await buildSalesSummary(etsy, 7, "2026-09-01", "2026-09-30");

    expect(summary).toEqual({
      period: { start_date: "2026-09-01", end_date: "2026-09-30", timezone: "UTC" },
      currency: "USD",
      orders: 2,
      units: 3,
      item_subtotal: 32,
      gross_total: 41.49,
      excluded_refunded_orders: 1,
      truncated: false,
      top_listings: [
        { listing_id: 10, title: "Mug", units: 2, revenue: 20 },
        { listing_id: 20, title: "Print", units: 1, revenue: 12 },
      ],
      slow_movers: [
        { listing_id: 40, title: "Old sticker", created: "2020-09-13" },
        { listing_id: 30, title: "Lamp", created: "2022-04-15" },
      ],
    });
    expect(etsy.get).toHaveBeenNthCalledWith(1, "/shops/7/receipts", {
      min_created: String(Date.UTC(2026, 8, 1) / 1000),
      max_created: String(Date.UTC(2026, 8, 30, 23, 59, 59) / 1000),
      was_canceled: "false",
      sort_on: "created",
      sort_order: "asc",
      limit: "100",
      offset: "0",
    });
    expect(etsy.get).toHaveBeenNthCalledWith(2, "/shops/7/listings", {
      state: "active",
      sort_on: "created",
      sort_order: "asc",
      limit: "100",
      offset: "0",
    });
  });

  it("recognizes Etsy's capitalized \"Fully Refunded\" status", async () => {
    const etsy = fakeEtsy(
      [{
        count: 2,
        results: [
          { status: "Paid", grandtotal: usd(1000), subtotal: usd(900), transactions: [{ listing_id: 10, title: "Mug", quantity: 1, price: usd(900) }] },
          { status: "Fully Refunded", grandtotal: usd(5000), subtotal: usd(5000), transactions: [{ listing_id: 30, title: "Lamp", quantity: 1, price: usd(5000) }] },
        ],
      }],
      [],
    );

    const summary = await buildSalesSummary(etsy, 7, "2026-09-01", "2026-09-30");

    expect(summary).toMatchObject({ orders: 1, units: 1, gross_total: 10, item_subtotal: 9, excluded_refunded_orders: 1 });
    expect(summary.top_listings.map((row) => row.listing_id)).toEqual([10]);
  });

  it("stops at the receipt cap and says so", async () => {
    const fullPage = {
      count: 2500,
      results: Array.from({ length: 100 }, () => ({ status: "paid", grandtotal: usd(100), subtotal: usd(100), transactions: [] })),
    };
    const etsy = fakeEtsy(Array.from({ length: 25 }, () => fullPage), []);

    const summary = await buildSalesSummary(etsy, 7, "2026-01-01", "2026-12-31");

    const receiptCalls = etsy.get.mock.calls.filter(([path]) => path.endsWith("/receipts"));
    expect(receiptCalls).toHaveLength(MAX_RECEIPTS / 100);
    expect(summary.orders).toBe(MAX_RECEIPTS);
    expect(summary.truncated).toBe(true);
  });

  it("reports no currency when there were no orders", async () => {
    const summary = await buildSalesSummary(fakeEtsy([], []), 7, "2026-09-01", "2026-09-01");
    expect(summary).toMatchObject({ orders: 0, units: 0, gross_total: 0, currency: null, top_listings: [], slow_movers: [] });
  });

  it("adds a listing up across orders, keeps the top 10, and fills 20 slow movers across listing pages", async () => {
    const line = (listing_id: number, quantity: number, cents: number) => ({ listing_id, title: `L${listing_id}`, quantity, price: usd(cents) });
    const paid = (...transactions: unknown[]) => ({ status: "paid", grandtotal: usd(0), subtotal: usd(0), transactions });
    const receipts = [
      paid(line(1, 1, 5000)),
      paid(line(1, 2, 5000)),
      ...Array.from({ length: 11 }, (_, i) => paid(line(i + 2, 1, 1000 - i * 10))),
    ];
    const listing = (listing_id: number) => ({ listing_id, title: `L${listing_id}`, created_timestamp: 1600000000 });
    const soldIds = Array.from({ length: 92 }, (_, i) => (i % 12) + 1);
    const etsy = fakeEtsy(
      [{ count: receipts.length, results: receipts }],
      [
        { count: 130, results: [...soldIds.map(listing), ...[201, 202, 203, 204, 205, 206, 207, 208].map(listing)] },
        { count: 130, results: Array.from({ length: 30 }, (_, i) => listing(301 + i)) },
      ],
    );

    const summary = await buildSalesSummary(etsy, 7, "2026-09-01", "2026-09-30");

    expect(summary.units).toBe(14);
    expect(summary.top_listings).toHaveLength(10);
    expect(summary.top_listings[0]).toEqual({ listing_id: 1, title: "L1", units: 3, revenue: 150 });
    expect(summary.top_listings.map((row) => row.listing_id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(summary.slow_movers.map((row) => row.listing_id)).toEqual([
      201, 202, 203, 204, 205, 206, 207, 208, 301, 302, 303, 304, 305, 306, 307, 308, 309, 310, 311, 312,
    ]);
    const listingOffsets = etsy.get.mock.calls
      .filter(([path]) => path.endsWith("/listings"))
      .map((call) => (call as unknown[])[1] as { offset: string })
      .map((params) => params.offset);
    expect(listingOffsets).toEqual(["0", "100"]);
  });

  it("stops paging receipts once Etsy's count is reached", async () => {
    const paidOrder = { status: "paid", grandtotal: usd(100), subtotal: usd(100), transactions: [] };
    const etsy = fakeEtsy(
      [
        { count: 150, results: Array.from({ length: 100 }, () => paidOrder) },
        { count: 150, results: Array.from({ length: 50 }, () => paidOrder) },
      ],
      [],
    );

    const summary = await buildSalesSummary(etsy, 7, "2026-09-01", "2026-09-30");

    expect(summary.orders).toBe(150);
    expect(summary.truncated).toBe(false);
    expect(etsy.get.mock.calls.filter(([path]) => path.endsWith("/receipts"))).toHaveLength(2);
  });
});
