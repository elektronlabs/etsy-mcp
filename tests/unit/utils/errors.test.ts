import { describe, it, expect } from "vitest";
import { EtsyApiError } from "../../../src/utils/errors.js";

describe("EtsyApiError message", () => {
  it("uses the error field of the body as the detail", () => {
    const err = new EtsyApiError(400, { error: "Invalid listing_id" });
    expect(err.message).toBe("Etsy API error (400): Invalid listing_id");
  });

  it("falls back to the JSON of a body with no error field", () => {
    const err = new EtsyApiError(403, { reason: "nope" });
    expect(err.message).toBe('Etsy API error (403): {"reason":"nope"}');
  });

  it("truncates a long JSON body to 300 characters", () => {
    const err = new EtsyApiError(400, { blob: "x".repeat(1000) });
    const detail = err.message.slice("Etsy API error (400): ".length);
    expect(detail).toHaveLength(300);
  });

  it("omits the detail when the body is null or undefined", () => {
    expect(new EtsyApiError(502, null).message).toBe("Etsy API error (502)");
    expect(new EtsyApiError(502, undefined).message).toBe("Etsy API error (502)");
  });

  it("lets an explicit message win", () => {
    expect(new EtsyApiError(400, { error: "x" }, "custom").message).toBe("custom");
  });
});
