import { describe, it, expect } from "vitest";

describe("Etsy API Ping (integration)", () => {
  it("can reach the Etsy API ping endpoint", async () => {
    const apiKey = process.env.ETSY_API_KEY;
    const sharedSecret = process.env.ETSY_SHARED_SECRET;
    if (!apiKey || !sharedSecret) {
      console.error("Skipping integration test: ETSY_API_KEY / ETSY_SHARED_SECRET not set");
      return;
    }

    const response = await fetch(
      "https://openapi.etsy.com/v3/application/openapi-ping",
      { headers: { "x-api-key": `${apiKey}:${sharedSecret}` } }
    );

    expect(response.ok).toBe(true);
    const data = await response.json();
    expect(data).toHaveProperty("application_id");
  });
});
