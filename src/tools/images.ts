import { z } from "zod";
import { readFile } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { EtsyClient } from "../client/etsy-client.js";
import type { ShopContext } from "../client/shop-context.js";
import { READ, WRITE_ADDITIVE, WRITE_DESTRUCTIVE } from "./annotations.js";
import { shopIdArg } from "./args.js";

export const IMAGE_EXTENSIONS = [".jpg", ".jpeg", ".png", ".gif", ".webp"] as const;
export const VIDEO_EXTENSIONS = [".mp4", ".mov"] as const;

/** Upload tools read local files, so only media files may leave the machine. */
export function checkUploadPath(filePath: string, allowed: readonly string[]): { path: string; name: string } {
  const path = resolve(filePath);
  const name = basename(path);
  if (!allowed.includes(extname(path).toLowerCase())) {
    throw new Error(`Refusing to upload ${name}: only ${allowed.join(", ")} files are allowed.`);
  }
  return { path, name };
}

export function registerImagesTools(server: McpServer, client: EtsyClient, shop: ShopContext): void {
  server.registerTool("get_listing_images", {
    description: "Get all images for a listing",
    inputSchema: { listing_id: z.number().describe("The listing ID") },
    annotations: READ,
  }, async (args) => {
    const data = await client.get(`/listings/${args.listing_id}/images`);
    return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
  });

  server.registerTool("upload_listing_image", {
    description: "Upload an image to a listing from a local file path",
    inputSchema: {
      shop_id: shopIdArg,
      listing_id: z.number().describe("The listing ID"),
      image_path: z.string().describe("Local file path to the image"),
      rank: z.number().optional().describe("Image rank/position (1-10)"),
      overwrite: z.boolean().optional().describe("Overwrite existing image at rank"),
      is_watermarked: z.boolean().optional().describe("Image has watermark"),
      alt_text: z.string().optional().describe("Alt text for the image"),
    },
    annotations: WRITE_ADDITIVE,
  }, async (args) => {
    const file = checkUploadPath(args.image_path, IMAGE_EXTENSIONS);
    const shopId = await shop.resolve(args.shop_id);
    const imageBuffer = await readFile(file.path);
    const formData = new FormData();
    formData.append("image", new Blob([imageBuffer]), file.name);
    if (args.rank) formData.append("rank", String(args.rank));
    if (args.overwrite !== undefined) formData.append("overwrite", String(args.overwrite));
    if (args.is_watermarked !== undefined) formData.append("is_watermarked", String(args.is_watermarked));
    if (args.alt_text) formData.append("alt_text", args.alt_text);
    const data = await client.uploadFile(`/shops/${shopId}/listings/${args.listing_id}/images`, formData);
    return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
  });

  server.registerTool("upload_listing_video", {
    description: "Upload a video to a listing from a local file path (max 15 seconds)",
    inputSchema: {
      shop_id: shopIdArg,
      listing_id: z.number().describe("The listing ID"),
      video_path: z.string().describe("Local file path to the video"),
    },
    annotations: WRITE_ADDITIVE,
  }, async (args) => {
    const file = checkUploadPath(args.video_path, VIDEO_EXTENSIONS);
    const shopId = await shop.resolve(args.shop_id);
    const videoBuffer = await readFile(file.path);
    const formData = new FormData();
    formData.append("video", new Blob([videoBuffer]), file.name);
    const data = await client.uploadFile(`/shops/${shopId}/listings/${args.listing_id}/videos`, formData);
    return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
  });

  server.registerTool("delete_listing_image", {
    description: "Delete an image from a listing",
    inputSchema: {
      shop_id: shopIdArg,
      listing_id: z.number().describe("The listing ID"),
      listing_image_id: z.number().describe("The image ID to delete"),
    },
    annotations: WRITE_DESTRUCTIVE,
  }, async (args) => {
    const shopId = await shop.resolve(args.shop_id);
    await client.delete(`/shops/${shopId}/listings/${args.listing_id}/images/${args.listing_image_id}`);
    return { content: [{ type: "text" as const, text: `Image ${args.listing_image_id} deleted from listing ${args.listing_id}.` }] };
  });
}
