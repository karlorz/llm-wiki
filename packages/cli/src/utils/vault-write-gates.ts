/**
 * Vault write gates (analysis M1–M3): dirty-volume, saturated mission stop,
 * and per-project daily capture budget.
 *
 * Source: projects/llm-wiki/work/2026-07-21-vault-uncommitted-backlog-improvements/analysis.md
 *
 * Pure decision helpers + thin git/fs scanners. Agents and CLI call these
 * before non-hygiene vault mutations so backlog cannot grow unbounded.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { err, ok, type Result } from "@skillwiki/shared";
import { git } from "./git.js";

/** Default expanded dirty-file threshold (M1). */
export const DEFAULT_DIRTY_VOLUME_THRESHOLD = 50;

/** Default per-project daily investigate/capture budget (M3). */
export const DEFAULT_CAPTURE_BUDGET = 20;

/** Default consecutive no-new-decision cycles before stop (M2). */
export const DEFAULT_NO_DECISION_STREAK = 3;

/** Error codes emitted in Result.error (machine-readable). */
export const GateError = {
  VAULT_DIRTY_BACKLOG: "VAULT_DIRTY_BACKLOG",
  DIMINISHING_RETURNS: "DIMINISHING_RETURNS",
  CAPTURE_BUDGET_EXHAUSTED: "CAPTURE_BUDGET_EXHAUSTED",
  USAGE: "USAGE",
  VAULT_PATH_INVALID: "VAULT_PATH_INVALID",
} as const;

export type GateErrorCode = (typeof GateError)[keyof typeof GateError];

/** Commands classified as hygiene — dirty volume does not block them. */
export const HYGIENE_COMMANDS = new Set([
  "write-preflight",
  "sync status",
  "sync push",
  "sync pull",
  "sync lock",
  "sync unlock",
  "sync resolve-derived",
  "sync journal list",
  "sync journal clear-stale",
  "sync lint-delta",
  "sync peers",
  "work-complete",
  "work-validate",
  "log materialize",
  "log migrate-legacy",
  "index rebuild",
  "projections materialize",
  "doctor",
  "health",
  "lint",
  "status",
  "path",
  "fleet context",
  "fleet validate",
  "fleet health",
]);

export function isHygieneCommand(command: string): boolean {
  const c = command.trim().toLowerCase().replace(/\s+/g, " ");
  if (HYGIENE_COMMANDS.has(c)) return true;
  // Prefix match for "sync …" hygiene family when callers pass short forms
  if (c === "sync" || c.startsWith("sync ")) {
    const rest = c.slice(5).trim();
    if (!rest) return true;
    return HYGIENE_COMMANDS.has(`sync ${rest}`);
  }
  return false;
}

// ─── M1 dirty volume ─────────────────────────────────────────────────────────

export interface DirtyBucket {
  bucket: string;
  count: number;
}

export interface DirtyVolumeReport {
  porcelain_lines: number;
  expanded_files: number;
  modified: number;
  untracked: number;
  buckets: DirtyBucket[];
  threshold: number;
  over_threshold: boolean;
  is_git_repo: boolean;
}

export interface DirtyVolumeGateInput {
  vault: string;
  /** Expanded dirty-file count threshold; default DEFAULT_DIRTY_VOLUME_THRESHOLD. */
  threshold?: number;
  /** When true, skip gate (hygiene / human override). */
  skip?: boolean;
  /** Command name for hygiene classification. */
  command?: string;
}

export interface DirtyVolumeGateAllow {
  allowed: true;
  reason: "under_threshold" | "hygiene" | "skipped" | "not_a_git_repo";
  report: DirtyVolumeReport;
}

export interface DirtyVolumeGateRefuse {
  allowed: false;
  reason: "over_threshold";
  code: typeof GateError.VAULT_DIRTY_BACKLOG;
  report: DirtyVolumeReport;
  humanHint: string;
}

export type DirtyVolumeGateResult = DirtyVolumeGateAllow | DirtyVolumeGateRefuse;

/**
 * Count expanded dirty files from `git status --porcelain` under vault.
 * Untracked directories are expanded to file counts (porcelain under-reports dirs).
 */
export function measureDirtyVolume(vault: string): DirtyVolumeReport {
  const empty = (extra: Partial<DirtyVolumeReport> = {}): DirtyVolumeReport => ({
    porcelain_lines: 0,
    expanded_files: 0,
    modified: 0,
    untracked: 0,
    buckets: [],
    threshold: 0,
    over_threshold: false,
    is_git_repo: false,
    ...extra,
  });

  if (!existsSync(vault) || !statSync(vault).isDirectory()) {
    return empty();
  }

  const gitDir = git(vault, ["rev-parse", "--absolute-git-dir"]);
  if (!gitDir) {
    return empty({ is_git_repo: false });
  }

  // Do not use git() here: its .trim() strips a leading space on the first
  // porcelain line when XY is " M"/" A"/etc., corrupting path parse (index.md → ndex.md).
  let porcelain = "";
  try {
    porcelain = execFileSync("git", ["status", "--porcelain"], {
      cwd: vault,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch {
    porcelain = "";
  }
  // Strip only trailing newlines; keep leading spaces on status codes.
  const lines = porcelain.replace(/\n+$/, "").split("\n").filter((l) => l.length > 0);
  let modified = 0;
  let untracked = 0;
  let expanded = 0;
  const bucketMap = new Map<string, number>();

  const addBucket = (rel: string, n: number) => {
    const top = rel.split(/[/\\]/)[0] || ".";
    bucketMap.set(top, (bucketMap.get(top) ?? 0) + n);
  };

  for (const line of lines) {
    // porcelain: "XY PATH", "XY ORIG -> PATH", or "?? path"
    const match = line.match(/^(.{2}) (.*)$/);
    if (!match) continue;
    const code = match[1]!;
    let pathPart = match[2] ?? "";
    if (pathPart.includes(" -> ")) {
      pathPart = pathPart.split(" -> ").pop() ?? pathPart;
    }
    // strip optional surrounding quotes from path
    const rel = pathPart.replace(/^"(.*)"$/, "$1").trim();
    if (!rel) continue;

    if (code === "??") {
      untracked += 1;
      const abs = join(vault, rel);
      if (existsSync(abs) && statSync(abs).isDirectory()) {
        const files = listFilesRecursive(abs);
        expanded += files.length;
        addBucket(rel, files.length);
      } else {
        expanded += 1;
        addBucket(rel, 1);
      }
    } else {
      modified += 1;
      expanded += 1;
      addBucket(rel, 1);
    }
  }

  const buckets = [...bucketMap.entries()]
    .map(([bucket, count]) => ({ bucket, count }))
    .sort((a, b) => b.count - a.count);

  return {
    porcelain_lines: lines.length,
    expanded_files: expanded,
    modified,
    untracked,
    buckets,
    threshold: 0,
    over_threshold: false,
    is_git_repo: true,
  };
}

function listFilesRecursive(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (name === ".git") continue;
    const p = join(dir, name);
    try {
      const st = statSync(p);
      if (st.isDirectory()) out.push(...listFilesRecursive(p));
      else if (st.isFile()) out.push(p);
    } catch {
      /* ignore */
    }
  }
  return out;
}

/**
 * M1: refuse non-hygiene writes when expanded dirty volume exceeds threshold.
 */
export function evaluateDirtyVolumeGate(input: DirtyVolumeGateInput): DirtyVolumeGateResult {
  const threshold = input.threshold ?? DEFAULT_DIRTY_VOLUME_THRESHOLD;
  const report = measureDirtyVolume(input.vault);
  report.threshold = threshold;
  report.over_threshold = report.is_git_repo && report.expanded_files > threshold;

  if (input.skip) {
    return { allowed: true, reason: "skipped", report };
  }
  if (input.command && isHygieneCommand(input.command)) {
    return { allowed: true, reason: "hygiene", report };
  }
  if (!report.is_git_repo) {
    return { allowed: true, reason: "not_a_git_repo", report };
  }
  if (!report.over_threshold) {
    return { allowed: true, reason: "under_threshold", report };
  }

  const top = report.buckets
    .slice(0, 5)
    .map((b) => `${b.bucket}:${b.count}`)
    .join(", ");
  return {
    allowed: false,
    reason: "over_threshold",
    code: GateError.VAULT_DIRTY_BACKLOG,
    report,
    humanHint:
      `Vault dirty volume ${report.expanded_files} exceeds threshold ${threshold} ` +
      `(porcelain ${report.porcelain_lines}; buckets: ${top || "none"}). ` +
      `Triage/commit keep-set before more non-hygiene writes. Hygiene commands still allowed.`,
  };
}

// ─── M2 saturated / diminishing returns ──────────────────────────────────────

const SATURATION_PATTERNS: RegExp[] = [
  /\benablement\s+\*\*saturated\*\*/i,
  /\bsaturated\b/i,
  /\bexplicit hold\b/i,
  /\bno further\b.*\bbatches\b/i,
  /\bpause (?:the )?job\b/i,
  /\bcancel research\b/i,
  /\bkill research\b/i,
  /\bdiminishing returns\b/i,
  /\bhuman send only\b/i,
  /\bno new decision\b/i,
  /\bHOLD:\b/,
  /\bstatus:\s*saturated\b/i,
  /\bmission:\s*cancelled\b/i,
  /\bcancelled mission\b/i,
];

export interface MissionCycleGateInput {
  /** Prior cycle artifact body or mission policy text. */
  priorArtifactText?: string;
  /** Consecutive cycles with no new decision class. */
  consecutiveNoNewDecision?: number;
  /** Threshold for no-new-decision streak; default DEFAULT_NO_DECISION_STREAK. */
  noDecisionThreshold?: number;
  /** Explicit human allow (+1). */
  humanAllow?: boolean;
  /** Mission kind label for structured output (pilot-q, research-cycle, …). */
  missionKind?: string;
}

export interface MissionCycleGateAllow {
  allowed: true;
  reason: "clean" | "human_allow";
  signals: string[];
}

export interface MissionCycleGateRefuse {
  allowed: false;
  reason: "saturated_text" | "no_decision_streak";
  code: typeof GateError.DIMINISHING_RETURNS;
  signals: string[];
  humanHint: string;
}

export type MissionCycleGateResult = MissionCycleGateAllow | MissionCycleGateRefuse;

/**
 * Detect saturation/hold/stop language in prior artifact text.
 * Pure string scan — no filesystem.
 */
export function detectSaturationSignals(text: string): string[] {
  if (!text) return [];
  const hits: string[] = [];
  for (const re of SATURATION_PATTERNS) {
    const m = text.match(re);
    if (m) hits.push(m[0]);
  }
  return hits;
}

/**
 * M2: refuse opening a further cycle artifact when prior text or streak signals stop.
 */
export function evaluateMissionCycleGate(input: MissionCycleGateInput): MissionCycleGateResult {
  if (input.humanAllow) {
    return { allowed: true, reason: "human_allow", signals: [] };
  }

  const signals = detectSaturationSignals(input.priorArtifactText ?? "");
  if (signals.length > 0) {
    return {
      allowed: false,
      reason: "saturated_text",
      code: GateError.DIMINISHING_RETURNS,
      signals,
      humanHint:
        `Mission saturated/hold/stop signal(s) in prior artifact: ${signals.slice(0, 5).join("; ")}. ` +
        `Refuse new ${input.missionKind ?? "cycle"} artifact without --human-allow.`,
    };
  }

  const streak = input.consecutiveNoNewDecision ?? 0;
  const thresh = input.noDecisionThreshold ?? DEFAULT_NO_DECISION_STREAK;
  if (streak >= thresh) {
    return {
      allowed: false,
      reason: "no_decision_streak",
      code: GateError.DIMINISHING_RETURNS,
      signals: [`no_new_decision_streak=${streak}`],
      humanHint:
        `${streak} consecutive no-new-decision cycles (≥ ${thresh}). ` +
        `Refuse further cycle artifacts without --human-allow.`,
    };
  }

  return { allowed: true, reason: "clean", signals: [] };
}

// ─── M3 capture budget ───────────────────────────────────────────────────────

export interface CaptureBudgetInput {
  vault: string;
  project: string;
  /** Calendar day YYYY-MM-DD; default UTC today. */
  day?: string;
  /** Max non-exempt captures per project per day; default DEFAULT_CAPTURE_BUDGET. */
  budget?: number;
  /** severity=P0 / p0 escape — budget does not apply. */
  severity?: string;
  /** When true, skip budget (explicit override). */
  skip?: boolean;
}

export interface CaptureBudgetReport {
  project: string;
  day: string;
  budget: number;
  used: number;
  remaining: number;
  paths: string[];
}

export interface CaptureBudgetAllow {
  allowed: true;
  reason: "under_budget" | "p0_escape" | "skipped";
  report: CaptureBudgetReport;
}

export interface CaptureBudgetRefuse {
  allowed: false;
  reason: "exhausted";
  code: typeof GateError.CAPTURE_BUDGET_EXHAUSTED;
  report: CaptureBudgetReport;
  humanHint: string;
}

export type CaptureBudgetResult = CaptureBudgetAllow | CaptureBudgetRefuse;

function utcDay(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Count investigate/research capture files for project on calendar day.
 * Looks at:
 * - raw/transcripts/YYYY-MM-DD-*.md with project in frontmatter or filename
 * - projects/{slug}/raw/transcripts/YYYY-MM-DD-*.md
 * - projects/{slug}/requirements/YYYY-MM-DD-*dev-loop*
 * - projects/{slug}/work/YYYY-MM-DD-*investigate* / *cycle*
 *
 * Hygiene contract: agents should commit or discard so untracked investigate
 * files do not grow past budget overnight (see CAPTURE_HYGIENE_CONTRACT).
 */
export const CAPTURE_HYGIENE_CONTRACT =
  "After each productive cycle (or when daily capture budget is reached), stage/commit " +
  "the keep-set or discard noise so untracked investigate files for the project stay " +
  `within the daily budget (default ${DEFAULT_CAPTURE_BUDGET}). P0 severity escapes the budget. ` +
  "Do not silently grow unbounded untracked investigate files.";

export function listProjectDayCaptures(vault: string, project: string, day: string): string[] {
  const found: string[] = [];
  const slug = project.replace(/^\[\[/, "").replace(/\]\]$/, "").trim();
  if (!slug || !existsSync(vault)) return found;

  const consider = (abs: string, rel: string) => {
    if (!rel.endsWith(".md")) return;
    const base = rel.split(/[/\\]/).pop() ?? "";
    if (!base.startsWith(day)) return;
    // Prefer files that look like captures / investigate / cycle notes
    const normRel = rel.replace(/\\/g, "/");
    const captureLike =
      /investigate|dev-loop|research-cycle|pilot-q|cycle-\d+|batch-|idle-no-new|observation/.test(normRel) ||
      /(^|\/)raw\/transcripts\//.test(normRel) ||
      /(^|\/)requirements\//.test(normRel);
    if (!captureLike && !/transcripts/.test(normRel)) {
      return;
    }
    // project association: path under projects/slug or frontmatter project
    const norm = rel.replace(/\\/g, "/");
    if (norm.startsWith(`projects/${slug}/`)) {
      found.push(norm);
      return;
    }
    if (norm.startsWith("raw/transcripts/")) {
      try {
        const body = readFileSync(abs, "utf8");
        if (body.includes(`project: ${slug}`) || body.includes(`project: "[[${slug}]]"`) || body.includes(`project: [[${slug}]]`)) {
          found.push(norm);
        } else if (base.includes(slug)) {
          found.push(norm);
        }
      } catch {
        /* ignore */
      }
    }
  };

  const walk = (dir: string, relBase: string) => {
    if (!existsSync(dir)) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      const abs = join(dir, name);
      const rel = relBase ? `${relBase}/${name}` : name;
      try {
        const st = statSync(abs);
        if (st.isDirectory()) walk(abs, rel);
        else if (st.isFile()) consider(abs, rel);
      } catch {
        /* ignore */
      }
    }
  };

  walk(join(vault, "raw", "transcripts"), "raw/transcripts");
  walk(join(vault, "projects", slug, "raw", "transcripts"), `projects/${slug}/raw/transcripts`);
  walk(join(vault, "projects", slug, "requirements"), `projects/${slug}/requirements`);
  // work items: only dirs starting with day
  const workRoot = join(vault, "projects", slug, "work");
  if (existsSync(workRoot)) {
    try {
      for (const name of readdirSync(workRoot)) {
        if (!name.startsWith(day)) continue;
        if (!/investigate|pilot-q|research|cycle|dev-loop/.test(name)) continue;
        const abs = join(workRoot, name);
        if (statSync(abs).isDirectory()) {
          for (const f of listFilesRecursive(abs)) {
            const rel = relative(vault, f).replace(/\\/g, "/");
            if (rel.endsWith(".md")) found.push(rel);
          }
        }
      }
    } catch {
      /* ignore */
    }
  }

  // queries research-cycle for day (global but mission-related) — only if project is playground/portfolio-lab style? skip global queries for per-project budget

  return [...new Set(found)].sort();
}

/**
 * M3: refuse further non-exempt captures when daily budget exhausted.
 */
export function evaluateCaptureBudget(input: CaptureBudgetInput): CaptureBudgetResult {
  const day = input.day ?? utcDay();
  const budget = input.budget ?? DEFAULT_CAPTURE_BUDGET;
  const paths = listProjectDayCaptures(input.vault, input.project, day);
  const used = paths.length;
  const report: CaptureBudgetReport = {
    project: input.project,
    day,
    budget,
    used,
    remaining: Math.max(0, budget - used),
    paths,
  };

  if (input.skip) {
    return { allowed: true, reason: "skipped", report };
  }

  const sev = (input.severity ?? "").toString().trim().toUpperCase();
  if (sev === "P0" || sev === "0") {
    return { allowed: true, reason: "p0_escape", report };
  }

  if (used >= budget) {
    return {
      allowed: false,
      reason: "exhausted",
      code: GateError.CAPTURE_BUDGET_EXHAUSTED,
      report,
      humanHint:
        `Capture budget exhausted for project ${input.project} on ${day}: ${used}/${budget}. ` +
        `${CAPTURE_HYGIENE_CONTRACT}`,
    };
  }

  return { allowed: true, reason: "under_budget", report };
}

// ─── Combined preflight for agents/CLI ───────────────────────────────────────

export type WritePreflightCheck = "dirty" | "mission" | "budget" | "all";

export interface WritePreflightInput {
  vault: string;
  command?: string;
  dirtyThreshold?: number;
  skipDirty?: boolean;
  /** Prior artifact text for M2. */
  priorArtifactText?: string;
  consecutiveNoNewDecision?: number;
  noDecisionThreshold?: number;
  humanAllow?: boolean;
  missionKind?: string;
  skipMission?: boolean;
  /** Project slug for M3. */
  project?: string;
  captureDay?: string;
  captureBudget?: number;
  severity?: string;
  skipBudget?: boolean;
  /** Which checks to run; default all that have enough input. */
  checks?: WritePreflightCheck[];
}

export interface WritePreflightOutput {
  allowed: boolean;
  checks: {
    dirty?: DirtyVolumeGateResult;
    mission?: MissionCycleGateResult;
    budget?: CaptureBudgetResult;
  };
  refused: Array<{ code: string; humanHint: string }>;
  hygiene_contract: string;
  humanHint: string;
}

/**
 * Run selected gates. Refuses if any selected gate refuses.
 * - dirty: always when vault provided (unless skip)
 * - mission: when priorArtifactText or consecutiveNoNewDecision provided, or checks includes mission
 * - budget: when project provided
 */
export function runWritePreflight(input: WritePreflightInput): Result<WritePreflightOutput> {
  if (!input.vault || !existsSync(input.vault)) {
    return err(GateError.VAULT_PATH_INVALID, { path: input.vault });
  }

  const want = new Set(input.checks ?? ["all"]);
  const runAll = want.has("all");
  const checks: WritePreflightOutput["checks"] = {};
  const refused: WritePreflightOutput["refused"] = [];

  if (runAll || want.has("dirty")) {
    const dirty = evaluateDirtyVolumeGate({
      vault: input.vault,
      threshold: input.dirtyThreshold,
      skip: input.skipDirty,
      command: input.command,
    });
    checks.dirty = dirty;
    if (!dirty.allowed) {
      refused.push({ code: dirty.code, humanHint: dirty.humanHint });
    }
  }

  const missionRequested =
    runAll ||
    want.has("mission") ||
    input.priorArtifactText != null ||
    input.consecutiveNoNewDecision != null;
  if (missionRequested && !input.skipMission) {
    // Only evaluate mission when caller supplied mission signals or forced mission check
    if (
      want.has("mission") ||
      (input.priorArtifactText != null && input.priorArtifactText.length > 0) ||
      (input.consecutiveNoNewDecision != null && input.consecutiveNoNewDecision > 0)
    ) {
      const mission = evaluateMissionCycleGate({
        priorArtifactText: input.priorArtifactText,
        consecutiveNoNewDecision: input.consecutiveNoNewDecision,
        noDecisionThreshold: input.noDecisionThreshold,
        humanAllow: input.humanAllow,
        missionKind: input.missionKind,
      });
      checks.mission = mission;
      if (!mission.allowed) {
        refused.push({ code: mission.code, humanHint: mission.humanHint });
      }
    }
  }

  if ((runAll || want.has("budget")) && input.project && !input.skipBudget) {
    const budget = evaluateCaptureBudget({
      vault: input.vault,
      project: input.project,
      day: input.captureDay,
      budget: input.captureBudget,
      severity: input.severity,
    });
    checks.budget = budget;
    if (!budget.allowed) {
      refused.push({ code: budget.code, humanHint: budget.humanHint });
    }
  }

  const allowed = refused.length === 0;
  return ok({
    allowed,
    checks,
    refused,
    hygiene_contract: CAPTURE_HYGIENE_CONTRACT,
    humanHint: allowed
      ? "write preflight: allowed"
      : `write preflight: refused — ${refused.map((r) => r.code).join(", ")}`,
  });
}

/**
 * Convert a gate refuse into the CLI Result shape used by emit().
 */
export function gateRefuseToResult(code: string, detail: unknown): Result<never> {
  return err(code, detail);
}
