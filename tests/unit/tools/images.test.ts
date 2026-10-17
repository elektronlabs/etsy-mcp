import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerImagesTools, checkUploadPath, IMAGE_EXTENSIONS, VIDEO_EXTENSIONS } from "../../../src/tools/images.js";
import { ShopContext } from "../../../src/client/shop-context.js";
import type { EtsyClient } from "../../../src/client/etsy-client.js";
import { connectClient, textOf } from "../../helpers/mcp.js";

describe("checkUploadPath", () => {
  it("accepts allowed extensions in any case and returns the file name", () => {
    const photo = join(tmpdir(), "photos", "a.PNG");
    expect(checkUploadPath(photo, IMAGE_EXTENSIONS)).toEqual({ path: photo, name: "a.PNG" });
    expect(checkUploadPath(join(tmpdir(), "clip.MOV"), VIDEO_EXTENSIONS).name).toBe("clip.MOV");
  });

  it("refuses everything else", () => {
    expect(() => checkUploadPath(join(tmpdir(), ".env"), IMAGE_EXTENSIONS)).toThrow("Refusing to upload");
    expect(() => checkUploadPath(join(tmpdir(), "tool.exe"), IMAGE_EXTENSIONS)).toThrow("Refusing to upload");
    expect(() => checkUploadPath(join(tmpdir(), "a.png"), VIDEO_EXTENSIONS)).toThrow("Refusing to upload");
  });
});

describe("upload_listing_image", () => {
  async function setup() {
    const uploadFile = vi.fn().mockResolvedValue({ listing_image_id: 1 });
    const client = { get: vi.fn(), uploadFile, delete: vi.fn() } as unknown as EtsyClient;
    const server = new McpServer({ name: "test", version: "0.0.0" });
    registerImagesTools(server, client, new ShopContext(client));
    return { uploadFile, mcp: await connectClient(server) };
  }

  it("refuses a non-image file without contacting Etsy", async () => {
    const { uploadFile, mcp } = await setup();
    const result = await mcp.callTool({
      name: "upload_listing_image",
      arguments: { shop_id: 1, listing_id: 2, image_path: join(tmpdir(), "secrets.env") },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Refusing to upload");
    expect(uploadFile).not.toHaveBeenCalled();
  });

  it("uploads an image under its own file name", async () => {
    const dir = mkdtempSync(join(tmpdir(), "etsy-img-"));
    const file = join(dir, "Mug Front.JPG");
    writeFileSync(file, "fake-bytes");
    const { uploadFile, mcp } = await setup();

    await mcp.callTool({ name: "upload_listing_image", arguments: { shop_id: 1, listing_id: 2, image_path: file } });

    expect(uploadFile).toHaveBeenCalledOnce();
    const [path, form] = uploadFile.mock.calls[0]!;
    expect(path).toBe("/shops/1/listings/2/images");
    expect(((form as FormData).get("image") as File).name).toBe("Mug Front.JPG");
  });
});
