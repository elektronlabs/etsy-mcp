import { z } from "zod";

/** Optional on every shop-scoped tool: omitted means the signed-in seller's own shop. */
export const shopIdArg = z.number().optional().describe("Shop ID (defaults to your shop)");
