import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { hashPassword, verifyPassword } from "../src/oauth.js";
import { writePasswordHashFile } from "../src/oauth-password-file.js";

describe("OAuth config loading", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "oauth-cfg-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

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

  it("gives precedence to hash file > env > YAML", () => {
    const pwhashYaml = hashPassword("pass-yaml");
    const pwhashEnv = hashPassword("pass-env");
    const pwhashDisk = hashPassword("pass-disk");

    writePasswordHashFile(tempDir, pwhashDisk);

    const yaml = `
vault_dir: /vault
token_map: /tokens.yaml
rclone:
  remote: seaweed-wiki
  bucket: cloud/wiki
oauth:
  enabled: true
  password_hash: "${pwhashYaml}"
  state_dir: ${JSON.stringify(tempDir)}
`;
    const cfg = loadConfig(
      {
        SKILLWIKI_MCP_OAUTH_PASSWORD_HASH: pwhashEnv,
      },
      yaml,
    );
    expect(cfg.oauth?.passwordHash).toBe(pwhashDisk);
    expect(verifyPassword("pass-disk", cfg.oauth!.passwordHash!)).toBe(true);
  });

  it("falls through to env then YAML when hash file is missing", () => {
    const pwhashYaml = hashPassword("pass-yaml");
    const pwhashEnv = hashPassword("pass-env");

    const yaml = `
vault_dir: /vault
token_map: /tokens.yaml
rclone:
  remote: seaweed-wiki
  bucket: cloud/wiki
oauth:
  enabled: true
  password_hash: "${pwhashYaml}"
  state_dir: ${JSON.stringify(tempDir)}
`;
    // Missing file falls through to env
    const cfgEnv = loadConfig(
      {
        SKILLWIKI_MCP_OAUTH_PASSWORD_HASH: pwhashEnv,
      },
      yaml,
    );
    expect(cfgEnv.oauth?.passwordHash).toBe(pwhashEnv);

    // Missing file without env falls through to YAML
    const cfgYaml = loadConfig({}, yaml);
    expect(cfgYaml.oauth?.passwordHash).toBe(pwhashYaml);
  });

  it("does not clobber env or YAML when hash file is empty", () => {
    const pwhashYaml = hashPassword("pass-yaml");
    const pwhashEnv = hashPassword("pass-env");

    // Write empty file
    writeFileSync(join(tempDir, "password.hash"), "");

    const yaml = `
vault_dir: /vault
token_map: /tokens.yaml
rclone:
  remote: seaweed-wiki
  bucket: cloud/wiki
oauth:
  enabled: true
  password_hash: "${pwhashYaml}"
  state_dir: ${JSON.stringify(tempDir)}
`;
    const cfgEnv = loadConfig(
      {
        SKILLWIKI_MCP_OAUTH_PASSWORD_HASH: pwhashEnv,
      },
      yaml,
    );
    expect(cfgEnv.oauth?.passwordHash).toBe(pwhashEnv);

    const cfgYaml = loadConfig({}, yaml);
    expect(cfgYaml.oauth?.passwordHash).toBe(pwhashYaml);
  });

  it("resolves stateDir from env over YAML when reading hash file", () => {
    const stateDirYaml = join(tempDir, "yaml-state");
    const stateDirEnv = join(tempDir, "env-state");

    const pwhashYamlDir = hashPassword("pass-yaml-dir");
    const pwhashEnvDir = hashPassword("pass-env-dir");

    writePasswordHashFile(stateDirYaml, pwhashYamlDir);
    writePasswordHashFile(stateDirEnv, pwhashEnvDir);

    const yaml = `
vault_dir: /vault
token_map: /tokens.yaml
rclone:
  remote: seaweed-wiki
  bucket: cloud/wiki
oauth:
  enabled: true
  state_dir: ${JSON.stringify(stateDirYaml)}
`;
    const cfg = loadConfig(
      {
        SKILLWIKI_MCP_OAUTH_STATE_DIR: stateDirEnv,
      },
      yaml,
    );
    expect(cfg.oauth?.stateDir).toBe(stateDirEnv);
    expect(cfg.oauth?.passwordHash).toBe(pwhashEnvDir);
  });
});

