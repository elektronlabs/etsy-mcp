import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";

/** Reads from Etsy; changes nothing. */
export const READ: ToolAnnotations = { readOnlyHint: true, openWorldHint: true };

/** Adds something new to the shop: a draft listing, a shipment, a photo. */
export const WRITE_ADDITIVE: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, openWorldHint: true };

/** Changes or removes existing shop data. */
export const WRITE_DESTRUCTIVE: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, openWorldHint: true };

/** Signs in: opens a browser and saves the token file locally. Changes nothing on Etsy. */
export const SIGN_IN: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, openWorldHint: true };
