import { describe, it, expect, vi, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEtsyMcpServer } from "../../../src/index.js";
import { connectClient } from "../../helpers/mcp.js";

function stubFetch() {
  const fetchMock = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ count: 0, results: [] }),
  }));
  vi.stubGlobal("fetch", fetchMock);
  return () => fetchMock.mock.calls.map(([url]) => new URL(url as string));
}

async function connect() {
  return connectClient(
    createEtsyMcpServer({
      apiKey: "test-key",
      sharedSecret: "test-secret",
      tokenStorePath: join(tmpdir(), `etsy-mcp-payments-${process.pid}.json`),
    })
  );
}

describe("Payments Tools", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("get_payments reads the payment for the receipt", async () => {
    const urls = stubFetch();
    const client = await connect();
    await client.callTool({ name: "get_payments", arguments: { shop_id: 5, receipt_id: 99 } });
    expect(urls().map((u) => u.pathname)).toEqual(["/v3/application/shops/5/receipts/99/payments"]);
  });

  it("get_ledger_entries always sends the required created range", async () => {
    const urls = stubFetch();
    const client = await connect();
    await client.callTool({
      name: "get_ledger_entries",
      arguments: { shop_id: 5, min_created: 1700000000, max_created: 1700086400 },
    });
    const [url] = urls();
    expect(url?.pathname).toBe("/v3/application/shops/5/payment-account/ledger-entries");
    expect(url?.searchParams.get("min_created")).toBe("1700000000");
    expect(url?.searchParams.get("max_created")).toBe("1700086400");
  });

  it("get_ledger_entries sends a range that starts at 0", async () => {
    const urls = stubFetch();
    const client = await connect();
    await client.callTool({ name: "get_ledger_entries", arguments: { shop_id: 5, min_created: 0, max_created: 100 } });
    expect(urls()[0]?.searchParams.get("min_created")).toBe("0");
  });

  it("get_ledger_entries is refused without the range, before calling Etsy", async () => {
    const urls = stubFetch();
    const client = await connect();
    const result = await client.callTool({ name: "get_ledger_entries", arguments: { shop_id: 5 } });
    expect(result.isError).toBe(true);
    expect(urls()).toEqual([]);
  });
});
