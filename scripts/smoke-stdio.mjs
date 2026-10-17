// Starts the built server over stdio the way Claude does, from an unrelated folder,
// and checks it answers with the expected tool list. Usage: npm run build && npm run smoke
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const EXPECTED_TOOLS = 33;
const entry = fileURLToPath(new URL("../dist/index.js", import.meta.url));

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [entry],
  cwd: tmpdir(),
  env: { ...process.env, ETSY_API_KEY: "smoke-key", ETSY_SHARED_SECRET: "smoke-secret" },
  stderr: "inherit",
});
const client = new Client({ name: "smoke", version: "0.0.0" });
await client.connect(transport);
const { tools } = await client.listTools();
await client.close();

if (tools.length !== EXPECTED_TOOLS) {
  console.error(`FAIL: expected ${EXPECTED_TOOLS} tools, got ${tools.length}`);
  process.exit(1);
}
console.log(`OK: started over stdio from ${tmpdir()} and listed ${tools.length} tools`);
