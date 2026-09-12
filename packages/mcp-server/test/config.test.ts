import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { DEFAULT_RCLONE_COPY_TIMEOUT_MS } from "../src/reconcile.js";

describe("loadConfig", () => {
  it("reads working dir, rclone remote, token map, and port from env", () => {
    const cfg = loadConfig({
      SKILLWIKI_MCP_VAULT: "/opt/skillwiki-mcp/vault",
      SKILLWIKI_MCP_PORT: "8801",
      SKILLWIKI_MCP_BIND: "127.0.0.1",
      SKILLWIKI_MCP_TOKEN_MAP: "/etc/skillwiki-mcp/tokens.yaml",
      SKILLWIKI_MCP_RCLONE_REMOTE: "seaweed-wiki",
      SKILLWIKI_MCP_RCLONE_BUCKET: "cloud/wiki",
      SKILLWIKI_MCP_S3_ENDPOINT: "http://10.10.1.12:8333",
    });
    expect(cfg.vaultDir).toBe("/opt/skillwiki-mcp/vault");
    expect(cfg.port).toBe(8801);
    expect(cfg.bind).toBe("127.0.0.1");
    expect(cfg.tokenMapPath).toBe("/etc/skillwiki-mcp/tokens.yaml");
    expect(cfg.rcloneRemote).toBe("seaweed-wiki");
    expect(cfg.rcloneBucket).toBe("cloud/wiki");
    expect(cfg.s3Endpoint).toBe("http://10.10.1.12:8333");
  });

  it("defaults to loopback bind and port 8801", () => {
    const cfg = loadConfig({
      SKILLWIKI_MCP_VAULT: "/vault",
      SKILLWIKI_MCP_TOKEN_MAP: "/tokens.yaml",
      SKILLWIKI_MCP_RCLONE_REMOTE: "seaweed-wiki",
      SKILLWIKI_MCP_RCLONE_BUCKET: "cloud/wiki",
    });
    expect(cfg.bind).toBe("127.0.0.1");
    expect(cfg.port).toBe(8801);
  });

  it("lets a config file supply values that env overrides", () => {
    const cfg = loadConfig(
      { SKILLWIKI_MCP_PORT: "9900" },
      `
vault_dir: /from-file
token_map: /from-file/tokens.yaml
bind: 0.0.0.0
port: 8801
rclone:
  remote: seaweed-wiki
  bucket: cloud/wiki-dev
s3:
  endpoint: http://seaweed:8333
`,
    );
    expect(cfg.vaultDir).toBe("/from-file");
    expect(cfg.port).toBe(9900);
    expect(cfg.bind).toBe("0.0.0.0");
    expect(cfg.rcloneBucket).toBe("cloud/wiki-dev");
    expect(cfg.s3Endpoint).toBe("http://seaweed:8333");
  });

  it("defaults rclone inbound copy timeout longer than 120s", () => {
    const cfg = loadConfig({
      SKILLWIKI_MCP_VAULT: "/vault",
      SKILLWIKI_MCP_TOKEN_MAP: "/tokens.yaml",
      SKILLWIKI_MCP_RCLONE_REMOTE: "seaweed-wiki",
      SKILLWIKI_MCP_RCLONE_BUCKET: "cloud/wiki-dev",
    });
    expect(cfg.rcloneTimeoutMs).toBe(DEFAULT_RCLONE_COPY_TIMEOUT_MS);
    expect(cfg.rcloneTimeoutMs).toBeGreaterThan(120_000);
  });

  it("loads rclone timeout from env and file", () => {
    const fromEnv = loadConfig({
      SKILLWIKI_MCP_VAULT: "/vault",
      SKILLWIKI_MCP_TOKEN_MAP: "/tokens.yaml",
      SKILLWIKI_MCP_RCLONE_REMOTE: "seaweed-wiki",
      SKILLWIKI_MCP_RCLONE_BUCKET: "cloud/wiki-dev",
      SKILLWIKI_MCP_RCLONE_TIMEOUT_MS: "480000",
    });
    expect(fromEnv.rcloneTimeoutMs).toBe(480_000);
    const fromFile = loadConfig(
      {
        SKILLWIKI_MCP_VAULT: "/vault",
        SKILLWIKI_MCP_TOKEN_MAP: "/tokens.yaml",
        SKILLWIKI_MCP_RCLONE_REMOTE: "seaweed-wiki",
        SKILLWIKI_MCP_RCLONE_BUCKET: "cloud/wiki-dev",
      },
      `
vault_dir: /vault
token_map: /tokens.yaml
rclone:
  remote: seaweed-wiki
  bucket: cloud/wiki-dev
  timeout_ms: 900000
`,
    );
    expect(fromFile.rcloneTimeoutMs).toBe(900_000);
  });
});
