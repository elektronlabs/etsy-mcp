import { describe, it, expect, vi, afterEach } from "vitest";
import net from "node:net";
import { OAuthClient } from "../../../src/auth/oauth.js";

function startFlow(port: number) {
  let markOpened!: (url: URL) => void;
  const opened = new Promise<URL>((resolve) => {
    markOpened = resolve;
  });
  const client = new OAuthClient({
    apiKey: "k",
    sharedSecret: "s",
    scopes: ["shops_r"],
    redirectPort: port,
    openBrowser: async (url) => markOpened(new URL(url)),
  });
  // Settle-safe wrapper so a rejection is never left unhandled while the test is still fetching.
  const outcome = client.startLocalAuthFlow().then(
    (value) => ({ value, error: null as Error | null }),
    (error: Error) => ({ value: null, error })
  );
  return { opened, outcome };
}

describe("OAuthClient local login", () => {
  afterEach(() => vi.restoreAllMocks());

  it("uses the registered redirect URI by default and honours a port override", () => {
    expect(new OAuthClient({ apiKey: "k", sharedSecret: "s", scopes: [] }).redirectUri())
      .toBe("http://localhost:3003/oauth/redirect");
    expect(new OAuthClient({ apiKey: "k", sharedSecret: "s", scopes: [], redirectPort: 4444 }).redirectUri())
      .toBe("http://localhost:4444/oauth/redirect");
  });

  it("listens on 127.0.0.1 only, ignores stray requests, and returns the code", async () => {
    const listen = vi.spyOn(net.Server.prototype, "listen");
    const { opened, outcome } = startFlow(38123);
    const authUrl = await opened;

    expect(listen.mock.calls[0]?.[1]).toBe("127.0.0.1");
    expect(authUrl.searchParams.get("redirect_uri")).toBe("http://localhost:38123/oauth/redirect");

    const stray = await fetch("http://127.0.0.1:38123/favicon.ico");
    expect(stray.status).toBe(404);

    const state = authUrl.searchParams.get("state");
    const callback = await fetch(`http://127.0.0.1:38123/oauth/redirect?code=abc&state=${state}`);
    expect(callback.status).toBe(200);

    const { value, error } = await outcome;
    expect(error).toBeNull();
    expect(value).toMatchObject({ code: "abc", redirectUri: "http://localhost:38123/oauth/redirect" });
  });

  it("rejects a callback with the wrong state", async () => {
    const { opened, outcome } = startFlow(38124);
    await opened;

    const callback = await fetch("http://127.0.0.1:38124/oauth/redirect?code=abc&state=wrong");
    expect(callback.status).toBe(403);

    const { error } = await outcome;
    expect(error?.message).toContain("state mismatch");
  });
});
