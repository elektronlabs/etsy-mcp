import { describe, it, expect, vi, beforeEach } from "vitest";
import { AuthManager } from "../../../src/auth/auth-manager.js";
import type { TokenStore, StoredTokens } from "../../../src/auth/token-store.js";
import type { OAuthClient } from "../../../src/auth/oauth.js";
import { EtsyAuthError, TokenRefreshError } from "../../../src/utils/errors.js";

function createMockTokenStore(): TokenStore {
  let stored: StoredTokens | null = null;
  return {
    load: vi.fn(async () => stored),
    save: vi.fn(async (tokens: StoredTokens) => { stored = tokens; }),
    clear: vi.fn(async () => { stored = null; }),
    isAccessTokenExpired: vi.fn((tokens: StoredTokens) => Date.now() >= tokens.expires_at),
    filePath: "/tmp/test-tokens.json",
  } as unknown as TokenStore;
}

function createMockOAuthClient(): OAuthClient {
  return {
    refreshAccessToken: vi.fn(async () => ({
      access_token: "refreshed-token",
      refresh_token: "new-refresh",
      expires_at: Date.now() + 3600_000,
    })),
    startLocalAuthFlow: vi.fn(async () => ({
      code: "test-code",
      redirectUri: "http://localhost:1234/callback",
      codeVerifier: "test-verifier",
    })),
    exchangeCode: vi.fn(async () => ({
      access_token: "new-token",
      refresh_token: "new-refresh",
      expires_at: Date.now() + 3600_000,
    })),
  } as unknown as OAuthClient;
}

describe("AuthManager", () => {
  let manager: AuthManager;
  let tokenStore: ReturnType<typeof createMockTokenStore>;
  let oauthClient: ReturnType<typeof createMockOAuthClient>;

  beforeEach(() => {
    tokenStore = createMockTokenStore();
    oauthClient = createMockOAuthClient();
    manager = new AuthManager(tokenStore, oauthClient);
  });

  it("returns null when no tokens exist", async () => {
    const token = await manager.getAccessToken();
    expect(token).toBeNull();
  });

  it("returns valid stored token", async () => {
    const validTokens: StoredTokens = {
      access_token: "valid-token",
      refresh_token: "refresh",
      expires_at: Date.now() + 3600_000,
    };
    await tokenStore.save(validTokens);
    const token = await manager.getAccessToken();
    expect(token).toBe("valid-token");
  });

  it("refreshes expired token automatically", async () => {
    const expiredTokens: StoredTokens = {
      access_token: "expired",
      refresh_token: "still-valid-refresh",
      expires_at: Date.now() - 1000,
    };
    await tokenStore.save(expiredTokens);
    const token = await manager.getAccessToken();
    expect(token).toBe("refreshed-token");
    expect(oauthClient.refreshAccessToken).toHaveBeenCalledWith("still-valid-refresh");
  });

  it("handleTokenExpired triggers refresh", async () => {
    const tokens: StoredTokens = {
      access_token: "old",
      refresh_token: "valid-refresh",
      expires_at: Date.now() + 3600_000,
    };
    await tokenStore.save(tokens);
    await manager.handleTokenExpired();
    expect(oauthClient.refreshAccessToken).toHaveBeenCalledWith("valid-refresh");
  });

  it("keeps the login and throws EtsyAuthError when a refresh fails for a network reason", async () => {
    await tokenStore.save({ access_token: "old", refresh_token: "r", expires_at: Date.now() - 1000 });
    (oauthClient.refreshAccessToken as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new TypeError("fetch failed"));

    await expect(manager.getAccessToken()).rejects.toThrow(EtsyAuthError);
    expect(tokenStore.clear).not.toHaveBeenCalled();
  });

  it("clears the login and asks to re-authenticate when the refresh token is dead", async () => {
    await tokenStore.save({ access_token: "old", refresh_token: "dead", expires_at: Date.now() - 1000 });
    (oauthClient.refreshAccessToken as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new TokenRefreshError(400, '{"error":"invalid_grant"}')
    );

    await expect(manager.getAccessToken()).rejects.toThrow("authenticate");
    expect(tokenStore.clear).toHaveBeenCalled();
  });

  it("handleTokenExpired without a login tells Claude to authenticate", async () => {
    await expect(manager.handleTokenExpired()).rejects.toThrow("authenticate");
  });

  it("authenticate starts a fresh login when the stored one is dead", async () => {
    await tokenStore.save({ access_token: "old", refresh_token: "dead", expires_at: Date.now() - 1000 });
    (oauthClient.refreshAccessToken as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new TokenRefreshError(400, '{"error":"invalid_grant"}')
    );

    await expect(manager.authenticate()).resolves.toBe("new-token");
    expect(oauthClient.startLocalAuthFlow).toHaveBeenCalled();
  });

  it("shares one refresh between parallel callers", async () => {
    await tokenStore.save({ access_token: "old", refresh_token: "r1", expires_at: Date.now() - 1000 });

    const both = await Promise.all([manager.getAccessToken(), manager.getAccessToken()]);

    expect(both).toEqual(["refreshed-token", "refreshed-token"]);
    expect(oauthClient.refreshAccessToken).toHaveBeenCalledTimes(1);
  });

  it("keeps a newer login saved by someone else when the old refresh token is rejected", async () => {
    await tokenStore.save({ access_token: "old", refresh_token: "r1", expires_at: Date.now() - 1000 });
    (oauthClient.refreshAccessToken as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      // Another process refreshed first and saved a new login.
      await tokenStore.save({ access_token: "fresh", refresh_token: "r2", expires_at: Date.now() + 3600_000 });
      throw new TokenRefreshError(400, '{"error":"invalid_grant"}');
    });

    await expect(manager.getAccessToken()).resolves.toBe("fresh");
    expect(tokenStore.clear).not.toHaveBeenCalled();
  });
});
