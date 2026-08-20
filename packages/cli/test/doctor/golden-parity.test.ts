import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { runDoctor } from "../../src/commands/doctor.js";

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const CLI_PKG = join(THIS_DIR, "..");
const REPO_ROOT = join(CLI_PKG, "..", "..");
const FIXTURE_DIR = join(
  REPO_ROOT,
  "vault-sync",
  "test",
  "fixtures",
  "snapshot-health",
);

const SCHEMA = `# Vault Schema\n\n## Tag Taxonomy\n\n\`\`\`yaml\ntaxonomy:\n  - model\n\`\`\`\n`;

function createHome(): string {
  const h = mkdtempSync(join(tmpdir(), "doctor-golden-home-"));
  mkdirSync(join(h, ".skillwiki"), { recursive: true });
  mkdirSync(join(h, ".claude", "skills", "example"), { recursive: true });
  writeFileSync(join(h, ".claude", "skills", "example", "SKILL.md"), "# Example Skill\n");
  return h;
}

function createFullVault(): string {
  const v = mkdtempSync(join(tmpdir(), "doctor-golden-vault-"));
  writeFileSync(join(v, "SCHEMA.md"), SCHEMA);
  for (const d of ["raw", "entities", "concepts", "meta"]) {
    mkdirSync(join(v, d), { recursive: true });
  }
  execSync("git init -b main", { cwd: v, stdio: "pipe" });
  execSync("git remote add origin https://example.com/vault.git", { cwd: v, stdio: "pipe" });
  execSync("git add -A", { cwd: v, stdio: "pipe" });
  execSync(`git -c user.name=test -c user.email=test@test commit -m "init"`, { cwd: v, stdio: "pipe" });
  return v;
}

describe("doctor golden parity tests", () => {
  it("captures golden check ID sequence and per-category output for a full git vault", async () => {
    const h = createHome();
    const v = createFullVault();
    writeFileSync(join(h, ".skillwiki", ".env"), `WIKI_PATH=${v}\nvault_sync.installed=true\nvault_sync.role=leaf\n`);

    const res = await runDoctor({
      home: h,
      envValue: undefined,
      argv: ["node", "skillwiki", "doctor"],
      currentVersion: "0.10.49",
    });

    expect(res.result.ok).toBe(true);
    if (!res.result.ok) return;

    const checkIds = res.result.data.checks.map(c => c.id);
    const expectedCheckIds = [
      // 1. System / Environment
      "node_version",
      "cli_channels",
      "config_file",
      "wiki_profiles",
      "project_local",
      "wiki_path_set",
      // 2. Vault Structure
      "wiki_path_exists",
      "vault_structure",
      "obsidian_templates",
      // 3. Git & Fleet
      "vault_git_remote",
      "fleet_identity",
      "sync_last_push",
      "vault_git_dirty",
      "vault_git_ahead",
      "vault_git_behind",
      "vault_git_pull_failures",
      "vault_local_git",
      "vault_github_remote",
      "vault_s3_remote",
      "vault_snapshotter_reachable",
      "vault_promotion_lag",
      // 4. Hygiene
      "dsstore_clean",
      "vault_conflict_markers",
      "vault_gitignore_hygiene",
      "vault_gitignore_tracked_scratch",
      // 5. S3 Mount Health
      "s3_mount_perf",
      "s3_mount_freshness",
      "rclone_flags",
      "rclone_version",
      "s3_write_test",
      "vfs_cache_health",
      // 6. Skills & Plugins
      "skills_installed",
      "skills_duplicate",
      "activation_grok",
      "npm_update",
      "plugin_version_drift",
      // 7. Vault Sync (leaf)
      "vault_sync_installed",
      "vault_sync_jobs_enabled",
      "vault_sync_last_push_age",
      "vault_sync_last_push_result",
      "vault_sync_last_fetch_status",
      "vault_sync_filter_present",
      "vault_sync_snapshot_guard",
      "vault_sync_pull_helper",
      "vault_sync_review_required_journals",
      // 8. Satellite
      "satellite_job_last_run",
      "satellite_job_timer",
      // 9. Metrics
      "vault_metric_pages",
      "vault_metric_orphans",
      "vault_metric_bridges",
      "vault_metric_cohesion",
      "vault_metric_log_size",
      // 10. Hardening Probes (T5)
      "fuse_staleness",
      "activation_marker",
      "ds_store_noise",
    ];

    expect(checkIds).toEqual(expectedCheckIds);
    expect(res.result.data.checks.length).toBe(55);
    expect(res.result.data.summary).toEqual({
      pass: expect.any(Number),
      info: 5, // 5 vault metrics
      warn: expect.any(Number),
      error: expect.any(Number),
    });
    expect(res.result.data.humanHint).toContain("Node.js version");
    expect(res.result.data.humanHint).toContain("Vault log size");
  });

  it("captures golden check ID sequence for unconfigured home (57 checks)", async () => {
    const h = createHome();

    const res = await runDoctor({
      home: h,
      envValue: undefined,
      argv: ["node", "skillwiki", "doctor"],
      currentVersion: "0.10.49",
    });

    expect(res.result.ok).toBe(true);
    if (!res.result.ok) return;

    expect(res.result.data.checks.length).toBe(57);

    // Verify unconfigured checks fail or skip as expected
    const wp = res.result.data.checks.find(c => c.id === "wiki_path_set");
    expect(wp?.status).toBe("error");

    const wpe = res.result.data.checks.find(c => c.id === "wiki_path_exists");
    expect(wpe?.status).toBe("error");

    const vs = res.result.data.checks.find(c => c.id === "vault_structure");
    expect(vs?.status).toBe("error");

    const metrics = res.result.data.checks.filter(c => c.id.startsWith("vault_metric_"));
    expect(metrics).toHaveLength(5);
    for (const m of metrics) {
      expect(m.status).toBe("info");
      expect(m.detail).toBe("no vault configured");
    }

    expect(res.exitCode).toBe(29); // ExitCode.DOCTOR_HAS_ERRORS
  });

  it("captures snapshotter role check ID sequence (56 checks)", async () => {
    const h = createHome();
    const v = createFullVault();
    const fixturePath = join(FIXTURE_DIR, "01-enabled-timer-successful-service-fresh-pushed.json");

    writeFileSync(
      join(h, ".skillwiki", ".env"),
      `WIKI_PATH=${v}\nvault_sync.installed=true\nvault_sync.role=snapshotter\nvault_sync.service_scope=system\n`
    );

    const shareDir = join(h, ".local", "share", "vault-sync", "bin");
    mkdirSync(shareDir, { recursive: true });
    writeFileSync(join(shareDir, "wiki-snapshot.sh"), "#!/usr/bin/env bash\n# --max-delete 10\n");

    const prior = process.env.VS_SNAPSHOT_HEALTH_FIXTURE;
    process.env.VS_SNAPSHOT_HEALTH_FIXTURE = fixturePath;
    let res!: Awaited<ReturnType<typeof runDoctor>>;
    try {
      res = await runDoctor({
        home: h,
        envValue: undefined,
        argv: ["node", "skillwiki", "doctor"],
        currentVersion: "0.10.49",
        env: process.env,
      });
    } finally {
      if (prior === undefined) delete process.env.VS_SNAPSHOT_HEALTH_FIXTURE;
      else process.env.VS_SNAPSHOT_HEALTH_FIXTURE = prior;
    }

    expect(res.result.ok).toBe(true);
    if (!res.result.ok) return;

    expect(res.result.data.checks.length).toBe(56);
    const snapIds = [
      "vault_sync_installed",
      "vault_sync_jobs_enabled",
      "vault_sync_snapshot_service_result",
      "vault_sync_last_push_age",
      "vault_sync_snapshot_consecutive_failures",
      "vault_sync_last_fetch_status",
      "vault_sync_filter_present",
      "vault_sync_snapshot_guard",
    ];

    const actualSnapIds = res.result.data.checks
      .map(c => c.id)
      .filter(id => id.startsWith("vault_sync_") && !id.includes("pull_helper") && !id.includes("review_required"));
    expect(actualSnapIds).toEqual(snapIds);
  });

  it("captures specific check statuses under diagnostic fixtures", async () => {
    const h = createHome();
    const v = createFullVault();

    // 1. Add complete conflict markers in a concept page
    writeFileSync(
      join(v, "concepts", "conflict.md"),
      "# Conflict\n\n<<<<<<< HEAD\nleft\n=======\nright\n>>>>>>> other\n"
    );

    // 2. Add a .DS_Store file in raw/
    writeFileSync(join(v, "raw", ".DS_Store"), "dummy binary data");

    writeFileSync(join(h, ".skillwiki", ".env"), `WIKI_PATH=${v}\n`);

    const res = await runDoctor({
      home: h,
      envValue: undefined,
      argv: ["node", "skillwiki", "doctor"],
      currentVersion: "0.10.49",
    });

    expect(res.result.ok).toBe(true);
    if (!res.result.ok) return;

    const conflict = res.result.data.checks.find(c => c.id === "vault_conflict_markers");
    expect(conflict?.status).toBe("error");
    expect(conflict?.detail).toContain("concepts/conflict.md");

    const dsstore = res.result.data.checks.find(c => c.id === "dsstore_clean");
    expect(dsstore?.status).toBe("info");
    expect(dsstore?.detail).toContain("1 .DS_Store file(s) found");
  });
});
