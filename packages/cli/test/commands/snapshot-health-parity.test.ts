import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, mkdirSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { runDoctor, snapshotterHealthChecks } from "../../src/commands/doctor.js";

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

function loadFixtures(): Array<{ fixture: ScenarioFixture; path: string }> {
  const files = readdirSync(FIXTURE_DIR)
    .filter(f => f.endsWith(".json"))
    .sort();
  if (files.length < 18) {
    throw new Error(`expected at least 18 fixtures, found ${files.length}`);
  }
  return files.map(f => ({
    fixture: JSON.parse(readFileSync(join(FIXTURE_DIR, f), "utf8")) as ScenarioFixture,
    path: join(FIXTURE_DIR, f),
  }));
}

/**
 * Drive runDoctor against a fixture-backed snapshotter environment.
 *
 * The fixture is injected via env vars that vaultSyncChecks reads when
 * VS_SNAPSHOT_HEALTH_FIXTURE is set (Phase 4 seam): the implementation
 * reads timer/service properties + the bounded log tail from the fixture
 * instead of calling systemctl or reading the live snapshot log.
 */
async function runFixture(fixture: ScenarioFixture, fixturePath: string): Promise<Map<string, { status: string; detail: string }>> {
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
  const shareDir = join(h, ".local", "share", "vault-sync", "bin");
  mkdirSync(shareDir, { recursive: true });
  writeFileSync(join(shareDir, "wiki-snapshot.sh"), "#!/usr/bin/env bash\n# --max-delete 10\n");

  const r = await runDoctor({
    home: h,
    envValue: undefined,
    argv: ["node", "skillwiki", "doctor"],
    currentVersion: "0.10.14",
    env: {
      VS_SNAPSHOT_HEALTH_FIXTURE: fixturePath,
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

// Load once for all suites in this file (fixture + cross-surface + live).
const ALL_FIXTURES = loadFixtures();

describe("snapshot-health scenario parity (TypeScript doctor)", () => {
  const fixtures = ALL_FIXTURES;

  it("loaded all required scenarios (18+ including empty-ActiveEnter)", () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(19);
  });

  for (const { fixture, path } of fixtures) {
    it(`scenario ${fixture.scenario_id}: ${fixture.description}`, async () => {
      const checks = await runFixture(fixture, path);
      for (const [id, expected] of Object.entries(fixture.expected)) {
        const actual = checks.get(id);
        expect(actual, `check '${id}' missing for ${fixture.scenario_id}`).toBeDefined();
        expect(actual!.status, `check '${id}' for ${fixture.scenario_id}`).toBe(expected.status);
      }
    });
  }

  it("produces the new check IDs for a healthy snapshotter fixture", async () => {
    const healthy = fixtures.find(f => f.fixture.scenario_id === "01-enabled-timer-successful-service-fresh-pushed")!;
    const checks = await runFixture(healthy.fixture, healthy.path);
    expect(checks.has("vault_sync_snapshot_service_result")).toBe(true);
    expect(checks.has("vault_sync_snapshot_consecutive_failures")).toBe(true);
  });
});

// ── Cross-surface parity: shell status.sh vs TypeScript doctor ──
// Both implementations consume the same fixture corpus. For each scenario,
// assert the shell and TS produce identical check IDs + severities for the
// snapshotter health checks. This is the explicit parity gate required by
// the v0.10.14 plan (Phase 4 step 10).
const STATUS_SH = join(REPO_ROOT, "vault-sync", "skills", "vault-sync-status", "status.sh");

function runShellStatusFixture(fixturePath: string, fixture: ScenarioFixture): Map<string, string> {
  const home = mkdtempSync(join(tmpdir(), "snap-shell-"));
  try {
    mkdirSync(join(home, "wiki"), { recursive: true });
    const json = execSync(
      `env -u WIKI_REMOTE HOME="${home}" WIKI_PATH="${home}/wiki" VS_ROLE=snapshotter VS_OS=linux ` +
      `VS_SERVICE_SCOPE="${fixture.service_scope}" VS_SNAPSHOT_HEALTH_FIXTURE="${fixturePath}" ` +
      `VS_SNAPSHOT_HEALTH_NOW="${fixture.now}" VS_SNAPSHOT_CADENCE_MINUTES="${fixture.cadence_minutes}" ` +
      `VS_SNAPSHOT_SERVICE_TIMEOUT_SECONDS="${fixture.service_timeout_seconds}" ` +
      `bash "${STATUS_SH}" --read-only --json`,
      { encoding: "utf8", timeout: 15000, stdio: ["pipe", "pipe", "pipe"] },
    );
    const map = new Map<string, string>();
    try {
      const d = JSON.parse(json);
      for (const c of d.checks ?? []) {
        map.set(c.id, c.status);
      }
    } catch { /* empty */ }
    return map;
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

describe("snapshot-health cross-surface parity (shell status.sh === TypeScript doctor)", () => {
  // status.sh uses platform_detect_os which only supports Linux and macOS.
  // Skip the shell half on Windows (MSYS) where the script cannot run.
  const isWindows = process.platform === "win32";
  const fixtures = ALL_FIXTURES;
  const parityIds = [
    "vault_sync_jobs_enabled",
    "vault_sync_snapshot_service_result",
    "vault_sync_last_push_age",
    "vault_sync_snapshot_consecutive_failures",
  ];

  for (const { fixture, path } of fixtures) {
    const skipOnWindows = isWindows ? it.skip : it;
    skipOnWindows(`shell and TS agree on ${fixture.scenario_id}`, async () => {
      const tsChecks = await runFixture(fixture, path);
      const shellChecks = runShellStatusFixture(path, fixture);
      for (const id of parityIds) {
        const ts = tsChecks.get(id)?.status;
        const shell = shellChecks.get(id);
        expect(shell, `shell missing '${id}' for ${fixture.scenario_id}`).toBeDefined();
        expect(ts, `TS missing '${id}' for ${fixture.scenario_id}`).toBeDefined();
        expect(ts, `parity mismatch '${id}' for ${fixture.scenario_id}: shell=${shell} ts=${ts}`).toBe(shell);
      }
    });
  }
});

// ── Live systemctl adapter gates (v0.10.15) ──────────────────
// Fixture parity does not prove live property names. These tests put the
// shared fake-systemctl first on PATH and assert case-sensitive requests
// plus completed-oneshot semantics when ActiveEnterTimestamp is empty.

const FAKE_SYSTEMCTL = join(FIXTURE_DIR, "fake-systemctl.sh");

/** Core live systemd names the health decision path must request. */
const LIVE_CORE_PROPS = [
  "UnitFileState",
  "ActiveState",
  "NextElapseUSecRealtime",
  "Result",
  "ExecMainStatus",
  "ActiveEnterTimestamp",
  "InactiveEnterTimestamp",
  "ExecMainStartTimestamp",
  "ExecMainExitTimestamp",
] as const;

type LiveProfile =
  | "completed"
  | "failed"
  | "never-run"
  | "running"
  | "timer-no-next"
  | "stale"
  | "consecutive-failures"
  | "unavailable";

function installFakeSystemctl(
  binDir: string,
  requestLog: string,
  profile: LiveProfile,
): void {
  mkdirSync(binDir, { recursive: true });
  // Thin wrapper: shared script selected via env (same as shell live-adapter).
  writeFileSync(
    join(binDir, "systemctl"),
    `#!/usr/bin/env bash\nexport FAKE_SYSTEMCTL_LOG=${JSON.stringify(requestLog)}\nexport FAKE_SYSTEMCTL_PROFILE=${JSON.stringify(profile)}\nexec bash ${JSON.stringify(FAKE_SYSTEMCTL)} "$@"\n`,
    { mode: 0o755 },
  );
}

function runLiveAdapter(
  scope: "system" | "user",
  profile: LiveProfile,
): { checks: Map<string, string>; requests: string } {
  const root = mkdtempSync(join(tmpdir(), "snap-live-"));
  try {
    const binDir = join(root, "bin");
    const requestLog = join(root, "requests.log");
    writeFileSync(requestLog, "");
    installFakeSystemctl(binDir, requestLog, profile);

    const logDir = join(root, "log");
    mkdirSync(logDir, { recursive: true });
    if (profile === "completed" || profile === "timer-no-next") {
      writeFileSync(
        join(logDir, "wiki-snapshot.log"),
        [
          "2026-07-25 11:32:10 === Wiki Snapshot: 20260725_113210 ===",
          "2026-07-25T11:33:40Z SNAPSHOT_COMPLETE schema=v1 outcome=pushed result=success ts=2026-07-25T11:33:40Z head=aaa origin=bbb",
          "",
        ].join("\n"),
      );
    } else if (profile === "stale") {
      writeFileSync(
        join(logDir, "wiki-snapshot.log"),
        "2026-07-25T09:30:00Z SNAPSHOT_COMPLETE schema=v1 outcome=pushed result=success ts=2026-07-25T09:30:00Z head=aaa origin=bbb\n",
      );
    } else if (profile === "consecutive-failures") {
      writeFileSync(
        join(logDir, "wiki-snapshot.log"),
        "2026-07-25 11:55:00 ERROR snapshot push failed\n"
        + "2026-07-25 11:56:00 ERROR snapshot retry failed\n",
      );
    }

    const prevPath = process.env.PATH ?? "";
    process.env.PATH = `${binDir}${prevPath ? `:${prevPath}` : ""}`;
    try {
      const results = snapshotterHealthChecks(scope, logDir, {
        VS_SNAPSHOT_HEALTH_NOW: "2026-07-25T12:00:00Z",
        VS_SNAPSHOT_CADENCE_MINUTES: "30",
        VS_SNAPSHOT_SERVICE_TIMEOUT_SECONDS: "900",
        PATH: process.env.PATH,
      } as NodeJS.ProcessEnv);
      const map = new Map<string, string>();
      for (const c of results) map.set(c.id, c.status);
      return { checks: map, requests: readFileSync(requestLog, "utf8") };
    } finally {
      process.env.PATH = prevPath;
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("snapshot-health live systemctl adapter (TypeScript doctor)", () => {
  const isWindows = process.platform === "win32";
  const maybeIt = isWindows ? it.skip : it;

  maybeIt("oneshot-empty-active-enter: completed oneshot with empty ActiveEnterTimestamp is pass (H2 invariant, system)", () => {
    const { checks, requests } = runLiveAdapter("system", "completed");
    expect(checks.get("vault_sync_jobs_enabled")).toBe("pass");
    expect(checks.get("vault_sync_snapshot_service_result")).toBe("pass");
    expect(checks.get("vault_sync_last_push_age")).toBe("pass");
    expect(requests).not.toMatch(/REFUSED_SNAKE_CASE/);
    expect(requests).not.toMatch(/unit_file_state|exec_main_status|active_enter_timestamp/);
    for (const prop of LIVE_CORE_PROPS) {
      expect(requests, `missing live property request: ${prop}`).toContain(prop);
    }
    expect(requests).toMatch(/^system\t/m);
  });

  maybeIt("completed oneshot works for user scope", () => {
    const { checks, requests } = runLiveAdapter("user", "completed");
    expect(checks.get("vault_sync_snapshot_service_result")).toBe("pass");
    expect(requests).toMatch(/^user\t/m);
  });

  maybeIt("never-run service with Result=success remains warn", () => {
    const { checks } = runLiveAdapter("system", "never-run");
    expect(checks.get("vault_sync_snapshot_service_result")).toBe("warn");
  });

  maybeIt("running service uses ExecMainStartTimestamp when ActiveEnterTimestamp empty", () => {
    const { checks } = runLiveAdapter("system", "running");
    expect(checks.get("vault_sync_snapshot_service_result")).toBe("pass");
  });

  maybeIt("failed Result and nonzero ExecMainStatus are errors", () => {
    const { checks } = runLiveAdapter("system", "failed");
    expect(checks.get("vault_sync_snapshot_service_result")).toBe("error");
    expect(checks.get("vault_sync_last_push_age")).toBe("error");
  });

  maybeIt("enabled timer without next trigger is an error", () => {
    const { checks } = runLiveAdapter("system", "timer-no-next");
    expect(checks.get("vault_sync_jobs_enabled")).toBe("error");
  });

  maybeIt("stale successful completion crosses the error threshold", () => {
    const { checks } = runLiveAdapter("system", "stale");
    expect(checks.get("vault_sync_last_push_age")).toBe("error");
  });

  maybeIt("two recent errors produce a consecutive-failure error", () => {
    const { checks } = runLiveAdapter("system", "consecutive-failures");
    expect(checks.get("vault_sync_snapshot_consecutive_failures")).toBe("error");
  });

  maybeIt("unavailable properties yield warn", () => {
    const { checks } = runLiveAdapter("system", "unavailable");
    expect(checks.get("vault_sync_jobs_enabled")).toBe("warn");
    expect(checks.get("vault_sync_snapshot_service_result")).toBe("warn");
  });
});
