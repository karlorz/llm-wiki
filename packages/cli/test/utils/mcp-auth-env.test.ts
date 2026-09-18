import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isMcpOnlyLeaf,
  mcpAuthFromEnv,
  mergeMcpAuthIntoEnv,
  redactMcpSecret,
  resolveMcpAuthEnv,
} from "../../src/utils/mcp-auth-env.js";

const PLANTED = "planted-mcp-dotenv-4b8e1c07a9f26d53";
const OVERRIDE = "planted-mcp-override-9a2c6e18b4d70f15";

function tmpHome(dotenv?: string): string {
  const h = mkdtempSync(join(tmpdir(), "mcp-auth-home-"));
  mkdirSync(join(h, ".skillwiki"), { recursive: true });
  if (dotenv !== undefined) writeFileSync(join(h, ".skillwiki", ".env"), dotenv);
  return h;
}

describe("resolveMcpAuthEnv", () => {
  it("reads token from dotenv when process env is empty", async () => {
    const home = tmpHome(`SKILLWIKI_MCP_TOKEN=${PLANTED}\nSKILLWIKI_HOST_ID=unknown-agent-fixture\n`);
    const auth = await resolveMcpAuthEnv({ home, env: {} });
    expect(auth.token).toBe(PLANTED);
    expect(auth.hostId).toBe("unknown-agent-fixture");
  });

  it("lets process env override dotenv", async () => {
    const home = tmpHome(`SKILLWIKI_MCP_TOKEN=${PLANTED}\n`);
    const auth = await resolveMcpAuthEnv({
      home,
      env: { SKILLWIKI_MCP_TOKEN: OVERRIDE },
    });
    expect(auth.token).toBe(OVERRIDE);
  });

  it("treats empty keys as absent", async () => {
    const home = tmpHome("SKILLWIKI_MCP_TOKEN=\nSKILLWIKI_MCP_URL=\nSKILLWIKI_HOST_ID=\n");
    const auth = await resolveMcpAuthEnv({
      home,
      env: { SKILLWIKI_MCP_TOKEN: "", SKILLWIKI_HOST_ID: "   " },
    });
    expect(auth.token).toBeUndefined();
    expect(auth.url).toBeUndefined();
    expect(auth.hostId).toBeUndefined();
  });
});

describe("mergeMcpAuthIntoEnv", () => {
  it("fills missing process keys from dotenv without clobbering set keys", async () => {
    const home = tmpHome(`SKILLWIKI_MCP_TOKEN=${PLANTED}\nSKILLWIKI_MCP_URL=https://wiki.example/mcp\n`);
    const merged = await mergeMcpAuthIntoEnv(home, { SKILLWIKI_MCP_URL: "https://override.example/mcp" });
    expect(merged.SKILLWIKI_MCP_TOKEN).toBe(PLANTED);
    expect(merged.SKILLWIKI_MCP_URL).toBe("https://override.example/mcp");
  });
});

describe("mcpAuthFromEnv / redactMcpSecret / isMcpOnlyLeaf", () => {
  it("omits empty process env values", () => {
    expect(mcpAuthFromEnv({ SKILLWIKI_MCP_TOKEN: "" }).token).toBeUndefined();
  });

  it("redacts the secret from text", () => {
    expect(redactMcpSecret(`bearer ${PLANTED} ok`, PLANTED)).toBe("bearer [REDACTED] ok");
  });

  it("detects MCP-only leaf only when vault-sync is not installed", () => {
    expect(isMcpOnlyLeaf({ resolvedPath: undefined, token: PLANTED, vaultSyncInstalled: false })).toBe(true);
    expect(isMcpOnlyLeaf({ resolvedPath: undefined, token: PLANTED, vaultSyncInstalled: true })).toBe(false);
    expect(isMcpOnlyLeaf({ resolvedPath: "/vault", token: PLANTED, vaultSyncInstalled: false })).toBe(false);
    expect(isMcpOnlyLeaf({ resolvedPath: undefined, token: undefined, vaultSyncInstalled: false })).toBe(false);
  });
});
