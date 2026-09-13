import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { hashPassword, verifyPassword } from "../src/oauth.js";

describe("OAuth config loading", () => {
  it("defaults oauth.enabled to false", () => {
    const cfg = loadConfig({
      SKILLWIKI_MCP_VAULT: "/vault",
      SKILLWIKI_MCP_TOKEN_MAP: "/tokens.yaml",
      SKILLWIKI_MCP_RCLONE_REMOTE: "seaweed-wiki",
      SKILLWIKI_MCP_RCLONE_BUCKET: "cloud/wiki",
    });
    expect(cfg.oauth?.enabled).toBe(false);
  });

  it("loads oauth config from environment variables", () => {
    const pwhash = hashPassword("test-operator-pass");
    const cfg = loadConfig({
      SKILLWIKI_MCP_VAULT: "/vault",
      SKILLWIKI_MCP_TOKEN_MAP: "/tokens.yaml",
      SKILLWIKI_MCP_RCLONE_REMOTE: "seaweed-wiki",
      SKILLWIKI_MCP_RCLONE_BUCKET: "cloud/wiki",
      SKILLWIKI_MCP_OAUTH_ENABLED: "true",
      SKILLWIKI_MCP_OAUTH_PASSWORD_HASH: pwhash,
      SKILLWIKI_MCP_OAUTH_ISSUER: "https://wiki.example.com",
      SKILLWIKI_MCP_OAUTH_STATE_DIR: "/var/lib/skillwiki-mcp/oauth",
      SKILLWIKI_MCP_OAUTH_WRITERS: JSON.stringify([{ client_id: "*", writer_id: "chatgpt-web" }]),
    });
    expect(cfg.oauth?.enabled).toBe(true);
    expect(cfg.oauth?.passwordHash).toBe(pwhash);
    expect(cfg.oauth?.issuer).toBe("https://wiki.example.com");
    expect(cfg.oauth?.stateDir).toBe("/var/lib/skillwiki-mcp/oauth");
    expect(cfg.oauth?.writers).toEqual([{ client_id: "*", writer_id: "chatgpt-web" }]);
    expect(verifyPassword("test-operator-pass", cfg.oauth!.passwordHash!)).toBe(true);
    expect(verifyPassword("wrong-pass", cfg.oauth!.passwordHash!)).toBe(false);
  });

  it("loads oauth config from file with env override", () => {
    const pwhashFile = hashPassword("pass-file");
    const pwhashEnv = hashPassword("pass-env");
    const yaml = `
vault_dir: /vault
token_map: /tokens.yaml
rclone:
  remote: seaweed-wiki
  bucket: cloud/wiki
oauth:
  enabled: true
  password_hash: "${pwhashFile}"
  issuer: "https://file.example.com"
  state_dir: "/tmp/oauth-file"
  writers:
    - client_id: "client-a"
      writer_id: "writer-file"
`;
    const cfg = loadConfig(
      {
        SKILLWIKI_MCP_OAUTH_PASSWORD_HASH: pwhashEnv,
      },
      yaml,
    );
    expect(cfg.oauth?.enabled).toBe(true);
    expect(cfg.oauth?.passwordHash).toBe(pwhashEnv);
    expect(cfg.oauth?.issuer).toBe("https://file.example.com");
    expect(cfg.oauth?.stateDir).toBe("/tmp/oauth-file");
    expect(cfg.oauth?.writers).toEqual([{ client_id: "client-a", writer_id: "writer-file" }]);
  });
});
