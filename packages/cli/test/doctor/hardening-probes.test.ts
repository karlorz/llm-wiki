import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { DoctorRunner, runDoctor } from "../../src/doctor/runner.js";
import { DOCTOR_PROBES } from "../../src/doctor/probes/index.js";
import {
  checkFuseStaleness,
  fuseStalenessProbe,
} from "../../src/doctor/probes/fuse-staleness.js";
import {
  checkActivationMarker,
  activationMarkerProbe,
} from "../../src/doctor/probes/activation-marker.js";
import {
  checkDsStoreNoise,
  dsStoreNoiseProbe,
} from "../../src/doctor/probes/ds-store-noise.js";

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const CLI_PKG = join(THIS_DIR, "..", "..");
const REPO_ROOT = join(CLI_PKG, "..", "..");
const ACTIVATION_TEMPLATE_PATH = join(
  REPO_ROOT,
  "packages",
  "skills",
  "using-skillwiki",
  "activation.md",
);

function createHome(): string {
  const h = mkdtempSync(join(tmpdir(), "doctor-harden-home-"));
  mkdirSync(join(h, ".skillwiki"), { recursive: true });
  mkdirSync(join(h, ".claude", "skills", "example"), { recursive: true });
  writeFileSync(join(h, ".claude", "skills", "example", "SKILL.md"), "# Example Skill\n");
  return h;
}

function createFullVault(): string {
  const v = mkdtempSync(join(tmpdir(), "doctor-harden-vault-"));
  writeFileSync(join(v, "SCHEMA.md"), "# Schema\n");
  for (const d of ["raw", "entities", "concepts", "meta"]) {
    mkdirSync(join(v, d), { recursive: true });
  }
  execSync("git init -b main", { cwd: v, stdio: "pipe" });
  execSync("git remote add origin https://example.com/vault.git", { cwd: v, stdio: "pipe" });
  execSync("git add -A", { cwd: v, stdio: "pipe" });
  execSync(`git -c user.name=test -c user.email=test@test commit -m "init"`, { cwd: v, stdio: "pipe" });
  return v;
}

describe("Hardening Probes (T5)", () => {
  describe("Registry order and probe structure", () => {
    it("registers 12 standard probes in deterministic order with new probes appended", () => {
      const runner = new DoctorRunner();
      const probes = runner.getRegisteredProbes();
      expect(probes.length).toBe(12);

      const probeIds = probes.map(p => p.id);
      expect(probeIds).toEqual([
        "environment",
        "vault_structure",
        "git_fleet",
        "hygiene",
        "s3_mount_health",
        "skills_plugins",
        "vault_sync",
        "satellite",
        "metrics",
        "fuse_staleness",
        "activation_marker",
        "ds_store_noise",
      ]);
    });
  });

  describe("Probe 1: fuse-staleness (Linux-only, advisory warning)", () => {
    it("skips cleanly on darwin (non-Linux platform gating)", () => {
      const res = checkFuseStaleness("/fake/vault", {
        platform: () => "darwin",
        detectFuseMount: () => ({ mountPoint: "/fake/vault", fsType: "fuse.rclone" }),
        findRcloneMountPid: () => 1234,
        parseRcloneFlags: () => new Map([["--dir-cache-time", "10m"]]),
        getRcloneArgs: () => [],
        queryRcloneRC: () => null,
      });

      expect(res.id).toBe("fuse_staleness");
      expect(res.status).toBe("pass");
      expect(res.detail).toContain("check skipped");
    });

    it("skips cleanly when vault path is undefined", () => {
      const res = checkFuseStaleness(undefined, {
        platform: () => "linux",
      });
      expect(res.id).toBe("fuse_staleness");
      expect(res.status).toBe("pass");
      expect(res.detail).toContain("check skipped");
    });

    it("skips cleanly on non-FUSE local disk vault on Linux", () => {
      const res = checkFuseStaleness("/local/vault", {
        platform: () => "linux",
        detectFuseMount: () => null,
      });
      expect(res.id).toBe("fuse_staleness");
      expect(res.status).toBe("pass");
      expect(res.detail).toContain("local disk");
      expect(res.detail).toContain("check skipped");
    });

    it("warns when FUSE mount exists but rclone PID cannot be found", () => {
      const res = checkFuseStaleness("/mnt/wiki", {
        platform: () => "linux",
        detectFuseMount: () => ({ mountPoint: "/mnt/wiki", fsType: "fuse.rclone" }),
        findRcloneMountPid: () => null,
      });
      expect(res.status).toBe("warn");
      expect(res.detail).toContain("no rclone process found");
    });

    it("passes when --dir-cache-time is within <=15m SLA (e.g. 10m)", () => {
      const res = checkFuseStaleness("/mnt/wiki", {
        platform: () => "linux",
        detectFuseMount: () => ({ mountPoint: "/mnt/wiki", fsType: "fuse.rclone" }),
        findRcloneMountPid: () => 4321,
        parseRcloneFlags: () => new Map([["--dir-cache-time", "10m"]]),
        getRcloneArgs: () => ["rclone", "mount", "remote:wiki", "/mnt/wiki"],
        queryRcloneRC: () => null,
      });
      expect(res.status).toBe("pass");
      expect(res.detail).toContain("within <=15m SLA");
    });

    it("passes when --dir-cache-time is default (unset, rclone default 5m)", () => {
      const res = checkFuseStaleness("/mnt/wiki", {
        platform: () => "linux",
        detectFuseMount: () => ({ mountPoint: "/mnt/wiki", fsType: "fuse.rclone" }),
        findRcloneMountPid: () => 4321,
        parseRcloneFlags: () => new Map(),
        getRcloneArgs: () => ["rclone", "mount", "remote:wiki", "/mnt/wiki"],
        queryRcloneRC: () => null,
      });
      expect(res.status).toBe("pass");
      expect(res.detail).toContain("default 5m");
    });

    it("warns when --dir-cache-time exceeds 15m (e.g. 30m or 1h)", () => {
      const res = checkFuseStaleness("/mnt/wiki", {
        platform: () => "linux",
        detectFuseMount: () => ({ mountPoint: "/mnt/wiki", fsType: "fuse.rclone" }),
        findRcloneMountPid: () => 4321,
        parseRcloneFlags: () => new Map([["--dir-cache-time", "30m"]]),
        getRcloneArgs: () => ["rclone", "mount", "remote:wiki", "/mnt/wiki"],
        queryRcloneRC: () => null,
      });
      expect(res.status).toBe("warn");
      expect(res.detail).toContain("exceeds 15m SLA");
    });

    it("warns when rclone RC reports VFS cache degradation", () => {
      const res = checkFuseStaleness("/mnt/wiki", {
        platform: () => "linux",
        detectFuseMount: () => ({ mountPoint: "/mnt/wiki", fsType: "fuse.rclone" }),
        findRcloneMountPid: () => 4321,
        parseRcloneFlags: () => new Map([["--dir-cache-time", "5m"], ["--rc", ""]]),
        getRcloneArgs: () => ["rclone", "mount", "remote:wiki", "/mnt/wiki"],
        queryRcloneRC: () => ({
          erroredFiles: 3,
          uploadsInProgress: 0,
          uploadsQueued: 15,
          outOfSpace: false,
          bytesUsed: 1000,
          files: 10,
          totalSize: "1000",
        }),
      });
      expect(res.status).toBe("warn");
      expect(res.detail).toContain("errored file(s)");
      expect(res.detail).toContain("queued (backlog)");
    });
  });

  describe("Probe 2: activation-marker (ADR-9 home-path contract)", () => {
    const validMarker = "Read @~/.grok/skillwiki.md for SkillWiki activation context.";
    const staleMarker = "Read @skillwiki.md for SkillWiki activation context.";

    it("passes when not a Grok host (~/.grok directory absent)", () => {
      const h = createHome();
      const res = checkActivationMarker(h);
      expect(res.id).toBe("activation_marker");
      expect(res.status).toBe("pass");
      expect(res.detail).toContain("Not a Grok host");
    });

    it("warns when ~/.grok/AGENTS.md is missing", () => {
      const h = createHome();
      mkdirSync(join(h, ".grok"), { recursive: true });
      const res = checkActivationMarker(h);
      expect(res.status).toBe("warn");
      expect(res.detail).toContain("~/.grok/AGENTS.md missing");
      expect(res.detail).toContain("npm run install:activation");
    });

    it("warns when ~/.grok/skillwiki.md is missing", () => {
      const h = createHome();
      mkdirSync(join(h, ".grok"), { recursive: true });
      writeFileSync(
        join(h, ".grok", "AGENTS.md"),
        `<!-- skillwiki:begin -->\n${validMarker}\n<!-- skillwiki:end -->\n`,
      );
      const res = checkActivationMarker(h);
      expect(res.status).toBe("warn");
      expect(res.detail).toContain("~/.grok/skillwiki.md missing");
    });

    // Pass REPO_ROOT so lookup uses tracked packages/skills/.../activation.md.
    // Do not require the gitignored packages/cli/skills/ copy.
    it("warns when marker in AGENTS.md uses stale relative reference (@skillwiki.md)", () => {
      const h = createHome();
      mkdirSync(join(h, ".grok"), { recursive: true });
      writeFileSync(
        join(h, ".grok", "AGENTS.md"),
        `<!-- skillwiki:begin -->\n${staleMarker}\n<!-- skillwiki:end -->\n`,
      );
      writeFileSync(join(h, ".grok", "skillwiki.md"), readFileSync(ACTIVATION_TEMPLATE_PATH, "utf8"));
      const res = checkActivationMarker(h, REPO_ROOT);
      expect(res.status).toBe("warn");
      expect(res.detail).toContain("stale (@skillwiki.md)");
    });

    it("warns when ~/.grok/skillwiki.md drifted from activation template", () => {
      const h = createHome();
      mkdirSync(join(h, ".grok"), { recursive: true });
      writeFileSync(
        join(h, ".grok", "AGENTS.md"),
        `<!-- skillwiki:begin -->\n${validMarker}\n<!-- skillwiki:end -->\n`,
      );
      writeFileSync(join(h, ".grok", "skillwiki.md"), "# Modified compact file\n");
      const res = checkActivationMarker(h, REPO_ROOT);
      expect(res.status).toBe("warn");
      expect(res.detail).toContain("differs from template");
    });

    it("passes when marker and compact file match ADR-9 contract exactly", () => {
      const h = createHome();
      mkdirSync(join(h, ".grok"), { recursive: true });
      writeFileSync(
        join(h, ".grok", "AGENTS.md"),
        `<!-- skillwiki:begin -->\n${validMarker}\n<!-- skillwiki:end -->\n`,
      );
      writeFileSync(join(h, ".grok", "skillwiki.md"), readFileSync(ACTIVATION_TEMPLATE_PATH, "utf8"));
      const res = checkActivationMarker(h, REPO_ROOT);
      expect(res.status).toBe("pass");
      expect(res.detail).toContain("home-path contract");
    });
  });

  describe("Probe 3: ds-store-noise (warning severity on vault-wide .DS_Store)", () => {
    it("skips cleanly when vault path is undefined", () => {
      const res = checkDsStoreNoise(undefined);
      expect(res.id).toBe("ds_store_noise");
      expect(res.status).toBe("pass");
      expect(res.detail).toContain("check skipped");
    });

    it("passes when no .DS_Store files exist in any tracked directory", () => {
      const v = createFullVault();
      const res = checkDsStoreNoise(v);
      expect(res.status).toBe("pass");
      expect(res.detail).toContain("No .DS_Store files found");
    });

    it("warns and reports count + example paths when .DS_Store exists in vault tracked dirs", () => {
      const v = createFullVault();
      writeFileSync(join(v, "concepts", ".DS_Store"), "mock binary");
      writeFileSync(join(v, "entities", ".DS_Store"), "mock binary");
      writeFileSync(join(v, "raw", ".DS_Store"), "mock binary");

      const res = checkDsStoreNoise(v);
      expect(res.id).toBe("ds_store_noise");
      expect(res.status).toBe("warn");
      expect(res.detail).toContain("3 .DS_Store file(s) found");
      expect(res.detail).toContain("concepts/.DS_Store");
      expect(res.detail).toContain("find");
    });
  });

  describe("End-to-end DoctorRunner execution with hardening probes", () => {
    it("executes all 12 probes and includes new check IDs in output", async () => {
      const h = createHome();
      const v = createFullVault();
      writeFileSync(join(h, ".skillwiki", ".env"), `WIKI_PATH=${v}\n`);

      const res = await runDoctor({
        home: h,
        envValue: undefined,
        argv: ["node", "skillwiki", "doctor"],
        currentVersion: "0.10.49",
      });

      expect(res.result.ok).toBe(true);
      if (!res.result.ok) return;

      const ids = res.result.data.checks.map(c => c.id);
      expect(ids).toContain("fuse_staleness");
      expect(ids).toContain("activation_marker");
      expect(ids).toContain("ds_store_noise");

      // Verify they are at the end of the check list
      const last3 = ids.slice(-3);
      expect(last3).toEqual(["fuse_staleness", "activation_marker", "ds_store_noise"]);
    });
  });
});
