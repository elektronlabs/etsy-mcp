import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { EtsyClient } from "../client/etsy-client.js";
import type { ShopContext } from "../client/shop-context.js";
import { paginationParams, formatPaginatedResponse } from "../utils/pagination.js";
import { READ, WRITE_ADDITIVE, WRITE_DESTRUCTIVE } from "./annotations.js";
import { limitArg, offsetArg, shopIdArg } from "./args.js";

export function registerListingsTools(server: McpServer, client: EtsyClient, shop: ShopContext): void {
  server.registerTool(
    "search_listings",
    {
      description: "Search active Etsy listings with keywords and filters",
      inputSchema: {
        keywords: z.string().optional().describe("Search keywords"),
        taxonomy_id: z.number().optional().describe("Filter by taxonomy/category ID"),
        min_price: z.number().optional().describe("Minimum price in USD"),
        max_price: z.number().optional().describe("Maximum price in USD"),
        sort_on: z.enum(["created", "price", "updated", "score"]).optional().describe("Sort field"),
        sort_order: z.enum(["asc", "desc"]).optional().describe("Sort direction"),
        limit: limitArg,
        offset: offsetArg,
      },
      annotations: READ,
    },
    async (args) => {
      const params: Record<string, string> = {
        ...paginationParams({ limit: args.limit, offset: args.offset }),
      };
      if (args.keywords) params.keywords = args.keywords;
      if (args.taxonomy_id) params.taxonomy_id = String(args.taxonomy_id);
      if (args.min_price) params.min_price = String(args.min_price);
      if (args.max_price) params.max_price = String(args.max_price);
      if (args.sort_on) params.sort_on = args.sort_on;
      if (args.sort_order) params.sort_order = args.sort_order;

      const data = await client.get<{ count: number; results: unknown[] }>("/listings/active", params);
      return {
        content: [{ type: "text" as const, text: formatPaginatedResponse(data, args.limit ?? 25, args.offset ?? 0) }],
      };
    }
  );

  server.registerTool(
    "get_listing",
    {
      description: "Get details of a specific Etsy listing",
      inputSchema: {
        listing_id: z.number().describe("The listing ID"),
        includes: z.array(z.enum(["images", "shop", "user", "translations", "inventory"])).optional().describe("Related resources to include"),
      },
      annotations: READ,
    },
    async (args) => {
      const params: Record<string, string> = {};
      if (args.includes?.length) params.includes = args.includes.join(",");
      const data = await client.get(`/listings/${args.listing_id}`, params);
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.registerTool(
    "create_draft_listing",
    {
      description: "Create a new draft listing in a shop",
      inputSchema: {
        shop_id: shopIdArg,
        title: z.string().describe("Listing title (max 140 chars)"),
        description: z.string().describe("Listing description"),
        price: z.number().describe("Price in shop's currency"),
        quantity: z.number().describe("Available quantity"),
        taxonomy_id: z.number().describe("Taxonomy/category ID"),
        who_made: z.enum(["i_did", "someone_else", "collective"]).describe("Who made the item"),
        when_made: z.enum(["made_to_order", "2020_2026", "2010_2019", "2007_2009", "before_2007", "2000_2006", "1990s", "1980s", "1970s", "1960s", "1950s", "1940s", "1930s", "1920s", "1910s", "1900s", "1800s", "1700s", "before_1700"]).describe("When it was made"),
        is_supply: z.boolean().describe("Is this a craft supply?"),
        shipping_profile_id: z.number().optional().describe("Shipping profile ID"),
        tags: z.array(z.string()).optional().describe("Tags (max 13)"),
        materials: z.array(z.string()).optional().describe("Materials list"),
        shop_section_id: z.number().optional().describe("Shop section ID"),
        is_customizable: z.boolean().optional().describe("Can be personalized"),
        is_digital: z.boolean().optional().describe("Digital download"),
      },
      annotations: WRITE_ADDITIVE,
    },
    async (args) => {
      const { shop_id, ...body } = args;
      const shopId = await shop.resolve(shop_id);
      const data = await client.post(`/shops/${shopId}/listings`, body);
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.registerTool(
    "update_listing",
    {
      description: "Update an existing listing's title, description, tags, materials, category or state. Set state to \"inactive\" to take it off sale. Etsy does not accept price or quantity here: change those with update_listing_inventory.",
      // Strict, so a stale habit like { price: 10 } is refused instead of silently dropped into an empty PATCH.
      inputSchema: z.strictObject({
        shop_id: shopIdArg,
        listing_id: z.number().describe("The listing ID"),
        title: z.string().optional().describe("Listing title"),
        description: z.string().optional().describe("Listing description"),
        tags: z.array(z.string()).optional().describe("Tags"),
        materials: z.array(z.string()).optional().describe("Materials"),
        state: z.enum(["active", "inactive"]).optional().describe("\"inactive\" takes the listing off sale; \"active\" puts it back on sale (a draft needs an image first)"),
        taxonomy_id: z.number().optional().describe("Taxonomy ID"),
      }),
      annotations: WRITE_DESTRUCTIVE,
    },
    async (args) => {
      const { shop_id, listing_id, ...body } = args;
      const shopId = await shop.resolve(shop_id);
      const data = await client.patch(`/shops/${shopId}/listings/${listing_id}`, body);
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.registerTool(
    "get_listings_by_shop",
    {
      description: "Get all listings for a shop, filterable by state",
      inputSchema: {
        shop_id: shopIdArg,
        state: z.enum(["active", "inactive", "draft", "expired", "sold_out"]).optional().describe("Filter by listing state"),
        limit: limitArg,
        offset: offsetArg,
      },
      annotations: READ,
    },
    async (args) => {
      const shopId = await shop.resolve(args.shop_id);
      const params: Record<string, string> = { ...paginationParams({ limit: args.limit, offset: args.offset }) };
      if (args.state) params.state = args.state;
      const data = await client.get<{ count: number; results: unknown[] }>(`/shops/${shopId}/listings`, params);
      return { content: [{ type: "text" as const, text: formatPaginatedResponse(data, args.limit ?? 25, args.offset ?? 0) }] };
    }
  );
}
