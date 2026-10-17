import { z } from "zod";

/** Optional on every shop-scoped tool: omitted means the signed-in seller's own shop. */
export const shopIdArg = z.number().optional().describe("Shop ID (defaults to your shop)");

/** Etsy caps a page at 100 results. Whole numbers only, so a caller paging with offset += limit never skips records. */
export const limitArg = z.number().int().min(1).max(100).optional().describe("Results per page (1-100, default 25)");

export const offsetArg = z.number().int().min(0).optional().describe("Offset for pagination");
