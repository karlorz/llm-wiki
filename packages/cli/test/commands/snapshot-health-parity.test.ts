import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, mkdirSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runDoctor } from "../../src/commands/doctor.js";

// Resolve the shared fixture corpus from the vault-sync package so both the
// shell and TypeScript parity gates consume identical scenarios.
// This file lives at packages/cli/test/commands/ -> up to packages/cli, then
// ../.. reaches the repo root.
const CLI_PKG = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const REPO_ROOT = join(CLI_PKG, "..");
const FIXTURE_DIR = join(
  REPO_ROOT,
  "vault-sync",
  "test",
  "fixtures",
  "snapshot-health",
);

interface TimerProps {
  load_state: string | null;
  unit_file_state: string | null;
  active_state: string | null;
  sub_state: string | null;
  next_elapse: string | null;
  result: string | null;
}

interface ServiceProps {
  load_state: string | null;
  active_state: string | null;
  sub_state: string | null;
  result: string | null;
  exec_main_status: number | null;
  exec_main_code: number | null;
  active_enter_timestamp: string | null;
  inactive_enter_timestamp: string | null;
}

interface ScenarioFixture {
  schema_version: number;
  scenario_id: string;
  description: string;
  now: string;
  cadence_minutes: number;
  service_timeout_seconds: number;
  service_scope: "user" | "system";
  timer: TimerProps;
  service: ServiceProps;
  log_records: string[];
  expected: Record<string, { status: "pass" | "warn" | "error"; facts?: Record<string, unknown> }>;
}

function loadFixtures(): ScenarioFixture[] {
  const files = readdirSync(FIXTURE_DIR)
    .filter(f => f.endsWith(".json"))
    .sort();
  if (files.length < 18) {
    throw new Error(`expected at least 18 fixtures, found ${files.length}`);
  }
  return files.map(f => JSON.parse(readFileSync(join(FIXTURE_DIR, f), "utf8")) as ScenarioFixture);
}

/**
 * Drive runDoctor against a fixture-backed snapshotter environment.
 *
 * The fixture is injected via env vars that vaultSyncChecks reads when
 * VS_SNAPSHOT_HEALTH_FIXTURE is set (Phase 4 seam): the implementation
 * reads timer/service properties + the bounded log tail from the fixture
 * instead of calling systemctl or reading the live snapshot log.
 */
async function runFixture(fixture: ScenarioFixture): Promise<Map<string, { status: string; detail: string }>> {
  const h = mkdtempSync(join(tmpdir(), "snap-health-"));
  mkdirSync(join(h, ".skillwiki"), { recursive: true });
  mkdirSync(join(h, ".claude", "skills", "example"), { recursive: true });
  writeFileSync(join(h, ".claude", "skills", "example", "SKILL.md"), "# Example Skill\n");

  // vault-sync installed + snapshotter role + system scope per fixture
  const envLines = [
    "vault_sync.installed=true",
    `vault_sync.role=snapshotter`,
    `vault_sync.service_scope=${fixture.service_scope}`,
  ];
  writeFileSync(join(h, ".skillwiki", ".env"), envLines.join("\n") + "\n");

  // Provide a snapshot script with the --max-delete guard so the guard check passes.
  const shareDir = fixture.service_scope === "system"
    ? join(h, ".local", "share", "vault-sync", "bin")
    : join(h, ".local", "share", "vault-sync", "bin");
  mkdirSync(shareDir, { recursive: true });
  writeFileSync(join(shareDir, "wiki-snapshot.sh"), "#!/usr/bin/env bash\n# --max-delete 10\n");

  const r = await runDoctor({
    home: h,
    envValue: undefined,
    argv: ["node", "skillwiki", "doctor"],
    currentVersion: "0.10.14",
    env: {
      VS_SNAPSHOT_HEALTH_FIXTURE: fixture.scenario_id,
      VS_SNAPSHOT_HEALTH_NOW: fixture.now,
      VS_SNAPSHOT_CADENCE_MINUTES: String(fixture.cadence_minutes),
      VS_SNAPSHOT_SERVICE_TIMEOUT_SECONDS: String(fixture.service_timeout_seconds),
    } as NodeJS.ProcessEnv,
  });

  const map = new Map<string, { status: string; detail: string }>();
  if (r.result.ok) {
    for (const c of r.result.data.checks) {
      map.set(c.id, { status: c.status, detail: c.detail });
    }
  }
  return map;
}

describe("snapshot-health scenario parity (TypeScript doctor)", () => {
  const fixtures = loadFixtures();

  it("loaded all 18 required scenarios", () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(18);
  });

  for (const fixture of fixtures) {
    it(`scenario ${fixture.scenario_id}: ${fixture.description}`, async () => {
      const checks = await runFixture(fixture);
      for (const [id, expected] of Object.entries(fixture.expected)) {
        const actual = checks.get(id);
        expect(actual, `check '${id}' missing for ${fixture.scenario_id}`).toBeDefined();
        expect(actual!.status, `check '${id}' for ${fixture.scenario_id}`).toBe(expected.status);
      }
    });
  }

  it("produces the new check IDs for a healthy snapshotter fixture", async () => {
    const healthy = fixtures.find(f => f.scenario_id === "01-enabled-timer-successful-service-fresh-pushed")!;
    const checks = await runFixture(healthy);
    expect(checks.has("vault_sync_snapshot_service_result")).toBe(true);
    expect(checks.has("vault_sync_snapshot_consecutive_failures")).toBe(true);
  });
});
