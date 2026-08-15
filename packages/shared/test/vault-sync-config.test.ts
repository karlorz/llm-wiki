import { describe, expect, it } from "vitest";
import {
  VaultSyncConfigSchema,
  VAULT_SYNC_KEYS,
  isVaultSyncKey,
  parseVaultSyncKeyValue,
} from "../src/schemas.js";

describe("VaultSyncConfig schema (A1)", () => {
  it("lists the 11 keys the installer writes", () => {
    expect(VAULT_SYNC_KEYS).toEqual([
      "vault_sync.installed",
      "vault_sync.role",
      "vault_sync.scheduler",
      "vault_sync.service_scope",
      "vault_sync.snapshot_profile",
      "vault_sync.snapshot_script",
      "vault_sync.snapshot_worktree",
      "vault_sync.fuse_refresh_enabled",
      "vault_sync.fuse_refresh_interval",
      "vault_sync.fuse_max_dir_cache",
      "vault_sync.fuse_service_scope",
    ]);
  });

  it("isVaultSyncKey accepts known keys and rejects unknown", () => {
    expect(isVaultSyncKey("vault_sync.role")).toBe(true);
    expect(isVaultSyncKey("vault_sync.fuse_max_dir_cache")).toBe(true);
    expect(isVaultSyncKey("vault_sync.unknown")).toBe(false);
    expect(isVaultSyncKey("WIKI_PATH")).toBe(false);
    expect(isVaultSyncKey("not_a_key")).toBe(false);
  });

  it("accepts a fully valid config object", () => {
    const parsed = VaultSyncConfigSchema.safeParse({
      "vault_sync.installed": "true",
      "vault_sync.role": "snapshotter",
      "vault_sync.scheduler": "systemd",
      "vault_sync.service_scope": "system",
      "vault_sync.snapshot_profile": "/etc/vault-sync/profiles/sg01-snapshotter.env",
      "vault_sync.snapshot_script": "/usr/local/bin/wiki-snapshot.sh",
      "vault_sync.snapshot_worktree": "/root/wiki-git",
      "vault_sync.fuse_refresh_enabled": "true",
      "vault_sync.fuse_refresh_interval": "300s",
      "vault_sync.fuse_max_dir_cache": "15m",
      "vault_sync.fuse_service_scope": "system",
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects unknown keys (strict)", () => {
    const parsed = VaultSyncConfigSchema.safeParse({
      "vault_sync.role": "leaf",
      "vault_sync.bogus": "value",
    });
    expect(parsed.success).toBe(false);
  });
});

describe("parseVaultSyncKeyValue (per-key validation used by config set)", () => {
  describe("booleans (installed, fuse_refresh_enabled)", () => {
    it("accepts true/false only", () => {
      expect(parseVaultSyncKeyValue("vault_sync.installed", "true").ok).toBe(true);
      expect(parseVaultSyncKeyValue("vault_sync.installed", "false").ok).toBe(true);
      expect(parseVaultSyncKeyValue("vault_sync.fuse_refresh_enabled", "true").ok).toBe(true);
    });
    it("rejects 1/0/yes/empty", () => {
      expect(parseVaultSyncKeyValue("vault_sync.installed", "1").ok).toBe(false);
      expect(parseVaultSyncKeyValue("vault_sync.installed", "0").ok).toBe(false);
      expect(parseVaultSyncKeyValue("vault_sync.installed", "yes").ok).toBe(false);
      expect(parseVaultSyncKeyValue("vault_sync.installed", "").ok).toBe(false);
    });
  });

  describe("role enum", () => {
    it("accepts leaf/snapshotter/none", () => {
      for (const v of ["leaf", "snapshotter", "none"]) {
        expect(parseVaultSyncKeyValue("vault_sync.role", v).ok).toBe(true);
      }
    });
    it("rejects invalid roles", () => {
      expect(parseVaultSyncKeyValue("vault_sync.role", "master").ok).toBe(false);
      expect(parseVaultSyncKeyValue("vault_sync.role", "SNAPSHOTTER").ok).toBe(false);
    });
  });

  describe("scheduler enum", () => {
    it("accepts systemd/launchd/none", () => {
      for (const v of ["systemd", "launchd", "none"]) {
        expect(parseVaultSyncKeyValue("vault_sync.scheduler", v).ok).toBe(true);
      }
    });
    it("rejects invalid schedulers", () => {
      expect(parseVaultSyncKeyValue("vault_sync.scheduler", "cron").ok).toBe(false);
    });
  });

  describe("service_scope / fuse_service_scope enum", () => {
    it("accepts user/system/none", () => {
      for (const v of ["user", "system", "none"]) {
        expect(parseVaultSyncKeyValue("vault_sync.service_scope", v).ok).toBe(true);
        expect(parseVaultSyncKeyValue("vault_sync.fuse_service_scope", v).ok).toBe(true);
      }
    });
    it("rejects invalid scopes", () => {
      expect(parseVaultSyncKeyValue("vault_sync.service_scope", "global").ok).toBe(false);
    });
  });

  describe("paths (snapshot_profile/script/worktree)", () => {
    it("accepts absolute paths", () => {
      expect(parseVaultSyncKeyValue("vault_sync.snapshot_profile", "/etc/vault-sync/p.env").ok).toBe(true);
      expect(parseVaultSyncKeyValue("vault_sync.snapshot_script", "/usr/local/bin/wiki-snapshot.sh").ok).toBe(true);
      expect(parseVaultSyncKeyValue("vault_sync.snapshot_worktree", "/root/wiki-git").ok).toBe(true);
    });
    it("accepts the none sentinel", () => {
      expect(parseVaultSyncKeyValue("vault_sync.snapshot_profile", "none").ok).toBe(true);
      expect(parseVaultSyncKeyValue("vault_sync.snapshot_worktree", "none").ok).toBe(true);
    });
    it("rejects relative paths", () => {
      expect(parseVaultSyncKeyValue("vault_sync.snapshot_profile", "relative/path.env").ok).toBe(false);
      expect(parseVaultSyncKeyValue("vault_sync.snapshot_worktree", "wiki-git").ok).toBe(false);
    });
    it("accepts Windows drive-letter paths on Windows", () => {
      if (process.platform !== "win32") return;
      expect(parseVaultSyncKeyValue("vault_sync.snapshot_worktree", "C:\\wiki-git").ok).toBe(true);
      expect(parseVaultSyncKeyValue("vault_sync.snapshot_script", "D:\\scripts\\wiki-snapshot.sh").ok).toBe(true);
    });
    it("rejects ~ expansion", () => {
      expect(parseVaultSyncKeyValue("vault_sync.snapshot_profile", "~/wiki").ok).toBe(false);
    });
  });

  describe("durations (fuse_refresh_interval, fuse_max_dir_cache)", () => {
    it("accepts Nm/Nh/Ns", () => {
      for (const v of ["15m", "300s", "2h", "1m"]) {
        expect(parseVaultSyncKeyValue("vault_sync.fuse_refresh_interval", v).ok).toBe(true);
        expect(parseVaultSyncKeyValue("vault_sync.fuse_max_dir_cache", v).ok).toBe(true);
      }
    });
    it("accepts none sentinel", () => {
      expect(parseVaultSyncKeyValue("vault_sync.fuse_refresh_interval", "none").ok).toBe(true);
    });
    it("rejects bare numbers without unit", () => {
      expect(parseVaultSyncKeyValue("vault_sync.fuse_refresh_interval", "300").ok).toBe(false);
      expect(parseVaultSyncKeyValue("vault_sync.fuse_max_dir_cache", "15").ok).toBe(false);
    });
    it("rejects malformed durations", () => {
      expect(parseVaultSyncKeyValue("vault_sync.fuse_refresh_interval", "15minutes").ok).toBe(false);
      expect(parseVaultSyncKeyValue("vault_sync.fuse_max_dir_cache", "m15").ok).toBe(false);
      expect(parseVaultSyncKeyValue("vault_sync.fuse_refresh_interval", "0s").ok).toBe(false);
      expect(parseVaultSyncKeyValue("vault_sync.fuse_max_dir_cache", "").ok).toBe(false);
    });
  });

  it("rejects unknown vault_sync keys", () => {
    const r = parseVaultSyncKeyValue("vault_sync.bogus", "value");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/unknown vault_sync key/);
  });

  it("returns a human-readable message on invalid values", () => {
    const r = parseVaultSyncKeyValue("vault_sync.role", "invalid");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message.length).toBeGreaterThan(0);
  });
});
