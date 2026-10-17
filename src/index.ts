#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { TokenStore } from "./auth/token-store.js";
import { OAuthClient } from "./auth/oauth.js";
import { AuthManager } from "./auth/auth-manager.js";
import { EtsyClient } from "./client/etsy-client.js";
import { ShopContext } from "./client/shop-context.js";
import { SIGN_IN } from "./tools/annotations.js";
import { registerListingsTools } from "./tools/listings.js";
import { registerShopTools } from "./tools/shop.js";
import { registerOrdersTools } from "./tools/orders.js";
import { registerTransactionsTools } from "./tools/transactions.js";
import { registerReviewsTools } from "./tools/reviews.js";
import { registerTaxonomyTools } from "./tools/taxonomy.js";
import { registerImagesTools } from "./tools/images.js";
import { registerInventoryTools } from "./tools/inventory.js";
import { registerPaymentsTools } from "./tools/payments.js";
import { registerStatsTools } from "./tools/stats.js";
import { etsyEnvPath, loadEnvFile } from "./env.js";
import { join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

/** The minimum scopes the registered tools need, per the `security` blocks in Etsy's OpenAPI spec. */
export const ETSY_SCOPES = ["listings_r", "listings_w", "shops_r", "transactions_r", "transactions_w"];

export interface ServerConfig {
  apiKey: string;
  sharedSecret: string;
  tokenStorePath?: string;
  scopes?: string[];
  redirectPort?: number;
}

export function createEtsyMcpServer(config: ServerConfig): McpServer {
  const server = new McpServer({
    name: "etsy-mcp",
    version: "1.0.0",
  });

  const tokenStorePath =
    config.tokenStorePath ?? join(homedir(), ".etsy-mcp", "tokens.json");

  const tokenStore = new TokenStore(tokenStorePath);
  const oauthClient = new OAuthClient({
    apiKey: config.apiKey,
    sharedSecret: config.sharedSecret,
    scopes: config.scopes ?? ETSY_SCOPES,
    redirectPort: config.redirectPort,
  });
  const authManager = new AuthManager(tokenStore, oauthClient);

  const client = new EtsyClient({
    apiKey: config.apiKey,
    sharedSecret: config.sharedSecret,
    getAccessToken: () => authManager.getAccessToken(),
    onTokenExpired: () => authManager.handleTokenExpired(),
  });

  server.registerTool(
    "authenticate",
    {
      description: "Authenticate with Etsy via OAuth 2.0. Opens a browser for consent. Required before using tools that need user authorization.",
      annotations: SIGN_IN,
    },
    async () => {
      const token = await authManager.authenticate();
      return {
        content: [{
          type: "text" as const,
          text: token ? "Successfully authenticated with Etsy!" : "Authentication failed.",
        }],
      };
    }
  );

  const shop = new ShopContext(client);

  registerListingsTools(server, client, shop);
  registerShopTools(server, client, shop);
  registerOrdersTools(server, client, shop);
  registerTransactionsTools(server, client, shop);
  registerReviewsTools(server, client, shop);
  registerTaxonomyTools(server, client);
  registerImagesTools(server, client, shop);
  registerInventoryTools(server, client);
  registerPaymentsTools(server, client, shop);
  registerStatsTools(server, client, shop);

  return server;
}

// CLI entry point - only run when executed directly
const currentFile = fileURLToPath(import.meta.url);
const isDirectRun = process.argv[1] && currentFile === process.argv[1];

if (isDirectRun) {
  loadEnvFile();
  const apiKey = process.env.ETSY_API_KEY;
  const sharedSecret = process.env.ETSY_SHARED_SECRET;

  if (!apiKey || !sharedSecret) {
    console.error("Error: ETSY_API_KEY and ETSY_SHARED_SECRET are required.");
    console.error(`Put them in ${etsyEnvPath()} (see .env.example) or set them as environment variables.`);
    process.exit(1);
  }

  const portSetting = process.env.ETSY_REDIRECT_PORT;
  const redirectPort = portSetting ? Number(portSetting) : undefined;
  if (redirectPort !== undefined && !(Number.isInteger(redirectPort) && redirectPort > 0 && redirectPort < 65536)) {
    console.error("Error: ETSY_REDIRECT_PORT must be a port number between 1 and 65535.");
    process.exit(1);
  }

  const server = createEtsyMcpServer({ apiKey, sharedSecret, redirectPort });
  const transport = new StdioServerTransport();
  server.connect(transport).catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}
