import { createHash, randomBytes } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import type { StoredTokens } from "./token-store.js";
import { TokenRefreshError } from "../utils/errors.js";

const ETSY_AUTH_URL = "https://www.etsy.com/oauth/connect";
const ETSY_TOKEN_URL = "https://api.etsy.com/v3/public/oauth/token";
const AUTH_TIMEOUT_MS = 120_000;

/** Etsy only accepts a redirect_uri that matches the app's registered callback URL exactly. */
export const DEFAULT_REDIRECT_PORT = 3003;
export const REDIRECT_PATH = "/oauth/redirect";
/** The callback server accepts connections from this machine only. */
export const CALLBACK_HOST = "127.0.0.1";

export interface OAuthConfig {
  apiKey: string;
  sharedSecret: string;
  scopes: string[];
  redirectPort?: number;
  /** Opens the consent page. Tests replace it so no real browser launches. */
  openBrowser?: (url: string) => Promise<void>;
}

async function openInDefaultBrowser(url: string): Promise<void> {
  const { default: open } = await import("open");
  await open(url);
}

function reply(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { "Content-Type": "text/html", Connection: "close" });
  res.end(`<html><body><h1>${message}</h1></body></html>`);
}

export class OAuthClient {
  private config: OAuthConfig;

  constructor(config: OAuthConfig) {
    this.config = config;
  }

  private get port(): number {
    return this.config.redirectPort ?? DEFAULT_REDIRECT_PORT;
  }

  redirectUri(): string {
    return `http://localhost:${this.port}${REDIRECT_PATH}`;
  }

  generateCodeVerifier(): string {
    return randomBytes(32).toString("base64url");
  }

  async generateCodeChallenge(verifier: string): Promise<string> {
    const hash = createHash("sha256").update(verifier).digest();
    return hash.toString("base64url");
  }

  async buildAuthorizationUrl(
    redirectUri: string
  ): Promise<{ url: string; codeVerifier: string; state: string }> {
    const codeVerifier = this.generateCodeVerifier();
    const codeChallenge = await this.generateCodeChallenge(codeVerifier);
    const state = randomBytes(16).toString("hex");

    const params = new URLSearchParams({
      response_type: "code",
      client_id: this.config.apiKey,
      redirect_uri: redirectUri,
      scope: this.config.scopes.join(" "),
      state,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
    });

    return {
      url: `${ETSY_AUTH_URL}?${params.toString().replace(/\+/g, "%20")}`,
      codeVerifier,
      state,
    };
  }

  async exchangeCode(
    code: string,
    codeVerifier: string,
    redirectUri: string
  ): Promise<StoredTokens> {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: this.config.apiKey,
      redirect_uri: redirectUri,
      code,
      code_verifier: codeVerifier,
    });

    const response = await fetch(ETSY_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Token exchange failed (${response.status}): ${text}`);
    }

    const data = (await response.json()) as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
    };

    return {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: Date.now() + data.expires_in * 1000,
    };
  }

  async refreshAccessToken(refreshToken: string): Promise<StoredTokens> {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: this.config.apiKey,
      refresh_token: refreshToken,
    });

    const response = await fetch(ETSY_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });

    if (!response.ok) {
      throw new TokenRefreshError(response.status, await response.text());
    }

    const data = (await response.json()) as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
    };

    return {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: Date.now() + data.expires_in * 1000,
    };
  }

  async startLocalAuthFlow(): Promise<{ code: string; redirectUri: string; codeVerifier: string }> {
    const redirectUri = this.redirectUri();
    const { url, codeVerifier, state } = await this.buildAuthorizationUrl(redirectUri);
    const openBrowser = this.config.openBrowser ?? openInDefaultBrowser;

    const code = await new Promise<string>((resolve, reject) => {
      const server = createServer((req, res) => {
        const callback = new URL(req.url ?? "/", "http://localhost");
        if (callback.pathname !== REDIRECT_PATH) {
          // Browsers also request /favicon.ico and the like; those must not end the login.
          res.writeHead(404, { Connection: "close" }).end();
          return;
        }

        const finish = (status: number, message: string, settle: () => void) => {
          reply(res, status, message);
          clearTimeout(timer);
          server.close();
          settle();
        };

        if (callback.searchParams.get("state") !== state) {
          finish(403, "State mismatch. Close this window and try again.", () =>
            reject(new Error("OAuth state mismatch: possible CSRF attack"))
          );
          return;
        }

        const returnedCode = callback.searchParams.get("code");
        if (!returnedCode) {
          const reason = callback.searchParams.get("error") ?? "no code returned";
          finish(400, "Authorization failed. You can close this window.", () =>
            reject(new Error(`Etsy authorization failed: ${reason}`))
          );
          return;
        }

        finish(200, "Authorization successful! You can close this window.", () => resolve(returnedCode));
      });

      const timer = setTimeout(() => {
        server.close();
        reject(new Error("OAuth flow timed out after 120 seconds"));
      }, AUTH_TIMEOUT_MS);

      server.on("error", (err: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        reject(
          err.code === "EADDRINUSE"
            ? new Error(`Port ${this.port} is busy. Close whatever is using it, or set ETSY_REDIRECT_PORT and register the matching callback URL on your Etsy app.`)
            : err
        );
      });

      server.listen(this.port, CALLBACK_HOST, () => {
        console.error(`\nOpen this URL to authorize:\n${url}\n`);
        openBrowser(url).catch(() => {
          // The URL is printed above, so the user can open it by hand.
        });
      });
    });

    return { code, redirectUri, codeVerifier };
  }
}
