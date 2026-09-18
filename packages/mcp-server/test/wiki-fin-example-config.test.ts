import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { configVaultRegistry, loadConfig } from "../src/config.js";
import { namespacesOverlap } from "../src/vault-registry.js";
import { parseMcpTokenPrincipals } from "../src/token-map.js";
import { normalizeGrants } from "../src/principal.js";

const here = dirname(fileURLToPath(import.meta.url));
const examplePath = join(here, "../config/wiki-fin.example.yaml");
const principalExamplePath = join(here, "../config/wiki-fin.principal.example.yaml");

describe("wiki-fin Slice 6a example config", () => {
  it("does not overlap live central cloud/wiki namespace", () => {
    const fileText = readFileSync(examplePath, "utf8");
    const cfg = loadConfig(
      {
        SKILLWIKI_MCP_VAULT: "/opt/skillwiki-mcp/vault",
        SKILLWIKI_MCP_TOKEN_MAP: "/etc/skillwiki-mcp/tokens.yaml",
        SKILLWIKI_MCP_RCLONE_REMOTE: "seaweed-wiki",
        SKILLWIKI_MCP_RCLONE_BUCKET: "cloud/wiki",
        SKILLWIKI_MCP_S3_BUCKET: "cloud",
        SKILLWIKI_MCP_S3_PREFIX: "wiki",
      },
      fileText,
    );
    const registry = configVaultRegistry(cfg);
    expect(registry.defaultVaultId).toBe("central");
    const extra = registry.entries.get("wiki-fin");
    expect(extra).toBeDefined();
    expect(extra!.enabled).toBe(false);
    expect(extra!.localRoot).toBe("/opt/skillwiki-mcp/vault-wiki-fin");
    expect(extra!.rclonePath).toBe("cloud/wiki-fin");
    expect(extra!.s3Bucket).toBe("cloud");
    expect(extra!.s3Prefix).toBe("wiki-fin");
    expect(extra!.snapshotAuthority).toBe("sg01-wiki-fin-snapshot");
    expect(extra!.projectionAuthority).toBe("sg01-wiki-fin-snapshot");
    const central = registry.entries.get("central")!;
    expect(central.localRoot).toBe("/opt/skillwiki-mcp/vault");
    expect(central.rclonePath).toBe("cloud/wiki");
    expect(namespacesOverlap("cloud/wiki", "cloud/wiki-fin")).toBe(false);
    expect(namespacesOverlap("cloud/wiki", "cloud/wiki/fin")).toBe(true);
    expect(central.localRoot).not.toBe(extra!.localRoot);
  });

  it("does not grant wiki-fin to string host-id central-only principals", () => {
    const example = readFileSync(principalExamplePath, "utf8");
    const hashA = "a".repeat(64);
    const hashB = "b".repeat(64);
    const hashC = "c".repeat(64);
    const yaml = `${hashA}: macos-dev\n${hashB}: cursor-box\n${hashC}: sg01-research\n${example}`;
    const principals = parseMcpTokenPrincipals(yaml);
    expect(principals.get(hashA)).toEqual({ writerId: "macos-dev" });
    expect(principals.get(hashB)).toEqual({ writerId: "cursor-box" });
    expect(principals.get("0".repeat(64))).toEqual({
      writerId: "grok-bot-wiki-fin",
      allowedVaults: ["wiki-fin"],
    });
    const fileText = readFileSync(examplePath, "utf8");
    const cfg = loadConfig(
      {
        SKILLWIKI_MCP_VAULT: "/opt/skillwiki-mcp/vault",
        SKILLWIKI_MCP_TOKEN_MAP: "/etc/skillwiki-mcp/tokens.yaml",
        SKILLWIKI_MCP_RCLONE_REMOTE: "seaweed-wiki",
        SKILLWIKI_MCP_RCLONE_BUCKET: "cloud/wiki",
        SKILLWIKI_MCP_S3_BUCKET: "cloud",
        SKILLWIKI_MCP_S3_PREFIX: "wiki",
      },
      fileText,
    );
    const registry = configVaultRegistry(cfg);
    const macos = normalizeGrants("macos-dev", principals.get(hashA)?.allowedVaults, registry);
    expect(macos.allowedVaults).toEqual(["central"]);
    const finance = normalizeGrants(
      "grok-bot-wiki-fin",
      principals.get("0".repeat(64))?.allowedVaults,
      registry,
    );
    expect(finance.allowedVaults).toEqual(["wiki-fin"]);
  });
});
