import { config as loadDotenv } from "dotenv";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Keys live beside the OAuth tokens in ~/.etsy-mcp, not in the project folder:
 * D:\PROJECTS is mirrored to the VPS by Syncthing, .env files included.
 */
export function etsyEnvPath(home: string = homedir()): string {
  return join(home, ".etsy-mcp", ".env");
}

/** Real env vars win. quiet: dotenv 17 otherwise logs to stdout, which corrupts the MCP stdio stream. */
export function loadEnvFile(path: string = etsyEnvPath()): void {
  loadDotenv({ path, quiet: true });
}
