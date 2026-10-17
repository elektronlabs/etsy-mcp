import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { etsyEnvPath, loadEnvFile } from "../../src/env.js";

function envFile(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "etsy-env-"));
  const path = join(dir, ".env");
  writeFileSync(path, contents);
  return path;
}

describe("env loading", () => {
  afterEach(() => {
    delete process.env.ETSY_ENV_TEST_A;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("keeps keys beside the tokens in ~/.etsy-mcp", () => {
    expect(etsyEnvPath("/home/devin")).toBe(join("/home/devin", ".etsy-mcp", ".env"));
  });

  it("loads values from the file without overriding real env vars", () => {
    vi.stubEnv("ETSY_ENV_TEST_B", "from-shell");
    loadEnvFile(envFile("ETSY_ENV_TEST_A=from-file\nETSY_ENV_TEST_B=from-file\n"));
    expect(process.env.ETSY_ENV_TEST_A).toBe("from-file");
    expect(process.env.ETSY_ENV_TEST_B).toBe("from-shell");
  });

  it("never prints to stdout, which would corrupt the MCP stdio stream", () => {
    const log = vi.spyOn(console, "log");
    const write = vi.spyOn(process.stdout, "write");
    loadEnvFile(envFile("ETSY_ENV_TEST_A=x\n"));
    loadEnvFile(join(tmpdir(), "does-not-exist", ".env"));
    expect(log).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });
});
