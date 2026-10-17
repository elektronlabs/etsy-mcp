import type { TokenStore } from "./token-store.js";
import type { OAuthClient } from "./oauth.js";
import { EtsyAuthError, TokenRefreshError } from "../utils/errors.js";

const NOT_SIGNED_IN = "This needs your Etsy login. Call the authenticate tool first.";
const LOGIN_EXPIRED = "Your Etsy login has expired. Call the authenticate tool to sign in again.";

export class AuthManager {
  private refreshing: Promise<string> | null = null;

  constructor(
    private tokenStore: TokenStore,
    private oauthClient: OAuthClient
  ) {}

  /** null means never signed in (public endpoints still work); a failed refresh throws EtsyAuthError. */
  async getAccessToken(): Promise<string | null> {
    const tokens = await this.tokenStore.load();
    if (!tokens) return null;

    if (!this.tokenStore.isAccessTokenExpired(tokens)) {
      return tokens.access_token;
    }
    return this.refresh(tokens.refresh_token);
  }

  async handleTokenExpired(): Promise<void> {
    const tokens = await this.tokenStore.load();
    if (!tokens) throw new EtsyAuthError(NOT_SIGNED_IN);
    await this.refresh(tokens.refresh_token);
  }

  async authenticate(): Promise<string> {
    try {
      const existing = await this.getAccessToken();
      if (existing) return existing;
    } catch (err) {
      if (!(err instanceof EtsyAuthError)) throw err;
      // Stored login is unusable: fall through to a fresh browser login.
    }

    const { code, redirectUri, codeVerifier } = await this.oauthClient.startLocalAuthFlow();
    const tokens = await this.oauthClient.exchangeCode(code, codeVerifier, redirectUri);
    await this.tokenStore.save(tokens);
    return tokens.access_token;
  }

  /** Parallel tool calls share one refresh, so a refresh token is never spent twice. */
  private refresh(refreshToken: string): Promise<string> {
    if (!this.refreshing) {
      this.refreshing = this.refreshOnce(refreshToken).finally(() => {
        this.refreshing = null;
      });
    }
    return this.refreshing;
  }

  private async refreshOnce(refreshToken: string): Promise<string> {
    try {
      const refreshed = await this.oauthClient.refreshAccessToken(refreshToken);
      await this.tokenStore.save(refreshed);
      return refreshed.access_token;
    } catch (err) {
      if (err instanceof TokenRefreshError && err.isInvalidGrant) {
        // Another process may have refreshed first and saved a newer login: keep it.
        const current = await this.tokenStore.load();
        if (current && current.refresh_token !== refreshToken) return current.access_token;
        await this.tokenStore.clear();
        throw new EtsyAuthError(LOGIN_EXPIRED);
      }
      const reason = err instanceof Error ? err.message : String(err);
      throw new EtsyAuthError(`Could not refresh your Etsy login (${reason}). Try again, or call the authenticate tool.`);
    }
  }
}
