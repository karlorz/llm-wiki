import { execFile } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { collectGithubCandidates } from "./github.js";
import { readResearchConfig, parseResearchConfig, type ResearchConfig } from "./config.js";
import { collectDuplicateSignals } from "./dedupe.js";
import { renderProposalCaptures } from "./captures.js";
import { createGitRunner, createSkillwikiRunner } from "./git.js";
import { maybeSendHeartbeat } from "./heartbeat.js";
import { buildAgentInput, writeAgentInput, type AgentInput, type AllowedOutputs } from "./input.js";
import { materializeOperationalRunManifest, publishGeneratedChanges } from "./publish.js";
import { materializePreviewRun } from "./preview.js";
import {
  createClaudeSynthesisRunner,
  createCodexSynthesisRunner,
  createFallbackSynthesisRunner,
  resolveSynthesisRuntimeOptions,
} from "./runner.js";
import { writeRunState, type AgentMemoryTrendRunState, type HeartbeatState } from "./run-state.js";
import {
  err,
  ok,
  type AgentMemoryTrendsCommand,
  type AgentMemoryTrendsCommandResult,
  type AgentMemoryTrendsContext,
  type CliRunResult,
  type CommandRunner,
  type DoctorCheck,
  type RefreshSessionBriefInput,
  type RefreshSessionBriefOutput,
  type Result,
} from "./types.js";

const COMMANDS = new Set<AgentMemoryTrendsCommand>(["doctor", "collect", "daily", "publish", "version"]);
const USAGE_TEXT = "Usage: agent-memory-trends <doctor|collect|daily|publish|version> [--dry-run] [--generate-only] [--preview-only] [--synthesis-retries <n>] [--synthesis-fallback <claude|none>] [--synthesis-timeout-ms <ms>] [--help] [--version]";
const DEFAULT_PROJECT = "llm-wiki";
const DEFAULT_TIMEZONE = "Asia/Hong_Kong";
const SESSION_BRIEF_FILES = [
  "meta/latest-session-brief.md",
  ".skillwiki/session-brief.md",
  ".skillwiki/session-brief.json",
];

interface LastOpSnapshot {
  path: string;
  existed: boolean;
  body: string;
}

export async function runAgentMemoryTrendsCli(
  argv: string[],
  context: AgentMemoryTrendsContext = {
    cwd: process.cwd(),
    env: process.env,
    now: new Date(),
  }
): Promise<CliRunResult<AgentMemoryTrendsCommandResult>> {
  const command = argv.find((arg) => !arg.startsWith("-")) as AgentMemoryTrendsCommand | undefined;
  const generatedAt = formatInstant(context.now);
  if (isHelpRequest(argv, command)) {
    return okRun("help", false, generatedAt, [], USAGE_TEXT);
  }

  if (isVersionRequest(argv, command)) {
    const version = readRunnerPackageVersion(context);
    if (!version.ok) return errorRun(version);
    return okRun("version", false, generatedAt, [], version.data);
  }

  if (!command || !COMMANDS.has(command)) {
    return {
      exitCode: 46,
      result: err("USAGE", {
        message: USAGE_TEXT,
      }),
    };
  }

  const options = parseCliOptions(argv);
  const dryRun = options.flags.has("dry-run");

  try {
    if (command === "doctor") {
      const checked = await runDoctor(options, context);
      if (!checked.ok) return errorRun(checked);
      return okRun(
        command,
        dryRun,
        generatedAt,
        [],
        `${command}: ok${dryRun ? " (dry-run)" : ""}; ${checked.data.filter((check) => check.status === "pass").length}/${checked.data.length} checks passed`,
        checked.data
      );
    }

    if (command === "collect") {
      const collected = await collectInput(options, context);
      if (!collected.ok) return errorRun(collected);
      return okRun(
        command,
        dryRun,
        generatedAt,
        [collected.data.inputPath],
        `collect: ok${dryRun ? " (dry-run)" : ""}; selected ${collected.data.input.selectedCandidates.length} candidate(s)`
      );
    }

    if (command === "daily") {
      const generateOnly = options.flags.has("generate-only") && !dryRun;
      const previewOnly = generateOnly && options.flags.has("preview-only");
      const result = await runDaily(options, context, dryRun, generateOnly, previewOnly);
      if (!result.ok) return errorRun(result);
      return okRun(
        command,
        dryRun,
        generatedAt,
        result.data.mutations,
        `daily: ok${dailyModeLabel(dryRun, generateOnly, previewOnly)}; selected ${result.data.selectedCandidateCount} candidate(s)`
      );
    }

    const published = await runPublish(options, context, dryRun);
    if (!published.ok) return errorRun(published);
    return okRun(command, dryRun, generatedAt, published.data.mutations, `publish: ok${dryRun ? " (dry-run)" : ""}`);
  } catch (error) {
    return errorRun(err("COMMAND_FAILED", error instanceof Error ? error.message : String(error)));
  }
}

function isHelpRequest(argv: string[], command: AgentMemoryTrendsCommand | undefined): boolean {
  return command === "help" || argv.includes("--help") || argv.includes("-h");
}

function isVersionRequest(argv: string[], command: AgentMemoryTrendsCommand | undefined): boolean {
  return command === "version" || argv.includes("--version") || argv.includes("-v");
}

function readRunnerPackageVersion(context: AgentMemoryTrendsContext): Result<string> {
  const candidates = [
    join(context.cwd, "packages", "agent-memory-trends", "package.json"),
    join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"),
  ];

  for (const path of candidates) {
    try {
      const body = context.readFile ? context.readFile(path) : readFileSync(path, "utf8");
      const parsed = JSON.parse(body) as { version?: unknown };
      if (typeof parsed.version === "string" && parsed.version.length > 0) return ok(parsed.version);
    } catch {
      // Try the next known package.json location.
    }
  }

  return err("VERSION_UNAVAILABLE", "could not read packages/agent-memory-trends/package.json");
}

interface ParsedCliOptions {
  values: Map<string, string>;
  flags: Set<string>;
}

interface ResolvedRunOptions {
  vault: string;
  repo: string;
  project: string;
  configPath: string;
  runDate: string;
  runId: string;
  manifestPath: string;
}

interface CollectedInput {
  options: ResolvedRunOptions;
  config: ResearchConfig;
  input: AgentInput;
  inputPath: string;
}

async function runDoctor(options: ParsedCliOptions, context: AgentMemoryTrendsContext): Promise<Result<DoctorCheck[]>> {
  const resolved = resolveRunOptions(options, context);
  const checks: DoctorCheck[] = [];
  const pathExists = context.pathExists ?? existsSync;
  const runGh = context.runGh ?? createGhRunner(context.cwd);
  const runCommand = context.runCommand ?? createCommandRunner();

  checks.push(checkConfig(resolved.configPath, context));
  checks.push({
    name: "vault_path",
    status: pathExists(resolved.vault) ? "pass" : "fail",
    message: pathExists(resolved.vault) ? `vault exists at ${resolved.vault}` : `vault path does not exist: ${resolved.vault}`,
  });
  checks.push({
    name: "repo_path",
    status: pathExists(resolved.repo) ? "pass" : "fail",
    message: pathExists(resolved.repo) ? `repo exists at ${resolved.repo}` : `repo path does not exist: ${resolved.repo}`,
  });

  checks.push(await runnerSourceFreshnessCheck(resolved.repo, runCommand));
  checks.push(await runnerVersionFreshnessCheck(resolved.repo, runCommand));
  checks.push(sessionBriefFreshnessCheck(resolved.vault, context));

  const ghAuth = await runGh(["auth", "status"]);
  const ghAuthCheck = commandCheck("gh_auth", ghAuth, "gh auth status passed", "gh auth status failed");
  checks.push(ghAuthCheck);

  if (ghAuthCheck.status === "pass") {
    const ghRateLimit = await runGh(["api", "rate_limit"]);
    checks.push(rateLimitCheck(ghRateLimit));
  } else {
    checks.push({
      name: "gh_rate_limit",
      status: "warn",
      message: "skipped because gh auth status failed",
    });
  }

  const codex = await runCommand("codex", ["doctor", "--json"], { cwd: resolved.repo });
  checks.push(codexDoctorCheck(codex));

  const skillwiki = await runSkillwikiDoctor(resolved.repo, runCommand);
  checks.push(skillwikiDoctorCheck(skillwiki));

  const gitStatus = await runCommand("git", ["-C", resolved.vault, "status", "--short"], { cwd: resolved.repo });
  const gitClean = gitCleanCheck(gitStatus);
  checks.push(gitClean);
  if (gitClean.status === "pass") {
    const gitPush = await runCommand("git", ["-C", resolved.vault, "push", "--dry-run", "origin", "main"], { cwd: resolved.repo });
    checks.push(commandCheck("vault_git_push", gitPush, "vault Git push dry-run passed", "vault Git push dry-run failed"));
  } else {
    checks.push({
      name: "vault_git_push",
      status: "warn",
      message: "skipped because vault working tree is not clean",
    });
  }

  checks.push({
    name: "heartbeat_env",
    status: context.env.AGENT_MEMORY_TRENDS_HEARTBEAT_URL ? "pass" : "warn",
    message: context.env.AGENT_MEMORY_TRENDS_HEARTBEAT_URL
      ? "heartbeat URL is configured"
      : "AGENT_MEMORY_TRENDS_HEARTBEAT_URL is unset; heartbeat will be skipped",
  });

  const failedChecks = checks.filter((check) => check.status === "fail").map((check) => check.name);
  if (failedChecks.length > 0) {
    return err("DOCTOR_FAILED", { failedChecks, checks });
  }

  return ok(checks);
}

function checkConfig(path: string, context: AgentMemoryTrendsContext): DoctorCheck {
  const parsed = loadResearchConfig(path, context);
  if (parsed.ok) {
    return {
      name: "config",
      status: "pass",
      message: `config parsed at ${path}`,
    };
  }
  return {
    name: "config",
    status: "fail",
    message: stringifyDetail(parsed.detail ?? parsed.error),
  };
}

function commandCheck(
  name: DoctorCheck["name"],
  result: { exitCode: number; stdout: string; stderr: string },
  okMessage: string,
  failMessage: string
): DoctorCheck {
  if (result.exitCode === 0) {
    return {
      name,
      status: "pass",
      message: okMessage,
    };
  }
  return {
    name,
    status: "fail",
    message: `${failMessage}: ${firstOutputLine(result.stderr || result.stdout)}`,
  };
}

async function runnerSourceFreshnessCheck(repo: string, runCommand: CommandRunner): Promise<DoctorCheck> {
  const fetch = await runCommand("git", ["-C", repo, "fetch", "origin", "main"], { cwd: repo });
  if (fetch.exitCode !== 0) {
    return {
      name: "runner_source",
      status: "warn",
      message: `could not fetch origin/main for runner freshness: ${firstOutputLine(fetch.stderr || fetch.stdout)}`,
    };
  }

  const head = await runCommand("git", ["-C", repo, "rev-parse", "HEAD"], { cwd: repo });
  const upstream = await runCommand("git", ["-C", repo, "rev-parse", "origin/main"], { cwd: repo });
  if (head.exitCode !== 0 || upstream.exitCode !== 0) {
    return {
      name: "runner_source",
      status: "warn",
      message: `could not resolve runner HEAD/origin-main (${firstOutputLine(head.stderr || head.stdout)}; ${firstOutputLine(upstream.stderr || upstream.stdout)})`,
    };
  }

  const headSha = head.stdout.trim();
  const upstreamSha = upstream.stdout.trim();
  if (headSha === upstreamSha) {
    return {
      name: "runner_source",
      status: "pass",
      message: `runner checkout is current at ${shortSha(headSha)} (origin/main)`,
    };
  }

  const behind = await runCommand("git", ["-C", repo, "merge-base", "--is-ancestor", "HEAD", "origin/main"], { cwd: repo });
  if (behind.exitCode === 0) {
    return {
      name: "runner_source",
      status: "fail",
      message: `runner checkout is behind origin/main: HEAD ${shortSha(headSha)}, origin/main ${shortSha(upstreamSha)}`,
    };
  }

  return {
    name: "runner_source",
    status: "warn",
    message: `runner checkout differs from origin/main: HEAD ${shortSha(headSha)}, origin/main ${shortSha(upstreamSha)}`,
  };
}

async function runnerVersionFreshnessCheck(repo: string, runCommand: CommandRunner): Promise<DoctorCheck> {
  const rootVersion = await nodePrint(runCommand, repo, "require('./package.json').version");
  const runnerVersion = await nodePrint(runCommand, repo, "require('./packages/agent-memory-trends/package.json').version");
  if (!rootVersion.ok || !runnerVersion.ok) {
    return {
      name: "runner_version",
      status: "fail",
      message: `could not read runner package versions: ${rootVersion.ok ? "root ok" : rootVersion.detail}; ${runnerVersion.ok ? "agent-memory-trends ok" : runnerVersion.detail}`,
    };
  }

  const expectedRoot = await gitShowPackageVersion(runCommand, repo, "package.json");
  const expectedRunner = await gitShowPackageVersion(runCommand, repo, "packages/agent-memory-trends/package.json");
  if (!expectedRoot.ok || !expectedRunner.ok) {
    if (rootVersion.data !== runnerVersion.data) {
      return {
        name: "runner_version",
        status: "fail",
        message: `runner package versions differ: root ${rootVersion.data}, agent-memory-trends ${runnerVersion.data}`,
      };
    }
    return {
      name: "runner_version",
      status: "warn",
      message: `runner package versions are ${rootVersion.data}, but origin/main expected versions could not be read`,
    };
  }

  const staleVersions: string[] = [];
  if (compareVersions(rootVersion.data, expectedRoot.data) < 0) staleVersions.push(`root ${rootVersion.data} < ${expectedRoot.data}`);
  if (compareVersions(runnerVersion.data, expectedRunner.data) < 0) {
    staleVersions.push(`agent-memory-trends ${runnerVersion.data} < ${expectedRunner.data}`);
  }
  if (rootVersion.data !== runnerVersion.data) {
    staleVersions.push(`root ${rootVersion.data} != agent-memory-trends ${runnerVersion.data}`);
  }

  if (staleVersions.length > 0) {
    return {
      name: "runner_version",
      status: "fail",
      message: `runner package version drift: ${staleVersions.join("; ")}`,
    };
  }

  return {
    name: "runner_version",
    status: "pass",
    message: `runner package versions current: root ${rootVersion.data}, agent-memory-trends ${runnerVersion.data}`,
  };
}

function sessionBriefFreshnessCheck(vault: string, context: AgentMemoryTrendsContext): DoctorCheck {
  const briefs = readSessionBriefGeneratedAts(vault, context);
  const missing = briefs.filter((brief) => !brief.generatedAt || !brief.raw);
  if (missing.length > 0) {
    return {
      name: "session_brief_freshness",
      status: "fail",
      message: `session brief file(s) missing or generated_at is unparsable: ${missing.map((brief) => brief.source).join(", ")}`,
    };
  }

  const datedBriefs = briefs.filter(hasGeneratedAt);
  const latest = readLatestAgentMemoryRunAt(vault, context);
  const olderThanLatest = latest
    ? datedBriefs.filter((brief) => brief.generatedAt.getTime() < latest.generatedAt.getTime())
    : [];
  if (latest && olderThanLatest.length > 0) {
    return {
      name: "session_brief_freshness",
      status: "fail",
      message: `session brief file(s) older than latest agent-memory run ${latest.raw} (${latest.source}): ${formatBriefSources(olderThanLatest)}`,
    };
  }

  const ages = datedBriefs.map((brief) => ({
    ...brief,
    ageHours: (context.now.getTime() - brief.generatedAt.getTime()) / (60 * 60 * 1000),
  }));
  const stale = ages.filter((brief) => brief.ageHours > 72);
  if (stale.length > 0) {
    return {
      name: "session_brief_freshness",
      status: "fail",
      message: `session brief file(s) stale: ${formatAgedBriefSources(stale)}`,
    };
  }
  const aging = ages.filter((brief) => brief.ageHours >= 24);
  if (aging.length > 0) {
    return {
      name: "session_brief_freshness",
      status: "warn",
      message: `session brief file(s) aging: ${formatAgedBriefSources(aging)}`,
    };
  }

  return {
    name: "session_brief_freshness",
    status: "pass",
    message: `session brief files are fresh: ${formatAgedBriefSources(ages)}`,
  };
}

async function runSkillwikiDoctor(repo: string, runCommand: CommandRunner): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const direct = await runCommand("skillwiki", ["doctor"], { cwd: repo });
  if (direct.exitCode === 0 || direct.stdout.trim() || direct.stderr.trim()) {
    return direct;
  }

  const build = await runCommand("npm", ["run", "-w", "skillwiki", "--silent", "build"], { cwd: repo });
  if (build.exitCode !== 0) {
    return {
      exitCode: build.exitCode,
      stdout: build.stdout,
      stderr: build.stderr || "repo-local skillwiki build failed",
    };
  }

  return runCommand(process.execPath, [join(repo, "packages", "cli", "dist", "cli.js"), "doctor"], { cwd: repo });
}

function skillwikiDoctorCheck(result: { exitCode: number; stdout: string; stderr: string }): DoctorCheck {
  const structured = parseSkillwikiDoctorSummary(result.stdout);
  if (structured) {
    if (!structured.ok || structured.errorCount > 0) {
      return {
        name: "skillwiki_doctor",
        status: "fail",
        message: `skillwiki doctor reported ${structured.warningCount} warning(s) and ${structured.errorCount} error(s)`,
      };
    }
    if (structured.warningCount > 0) {
      return {
        name: "skillwiki_doctor",
        status: "warn",
        message: `skillwiki doctor reported ${structured.warningCount} warning(s) and ${structured.errorCount} error(s)`,
      };
    }
    return {
      name: "skillwiki_doctor",
      status: "pass",
      message: "skillwiki doctor passed",
    };
  }

  return commandCheck("skillwiki_doctor", result, "skillwiki doctor passed", "skillwiki doctor failed");
}

function codexDoctorCheck(result: { exitCode: number; stdout: string; stderr: string }): DoctorCheck {
  const structured = parseCodexDoctorSummary(result.stdout);
  if (structured) {
    if (structured.failingChecks.length === 0) {
      if (structured.warningCount > 0) {
        return {
          name: "codex_doctor",
          status: "warn",
          message: `codex doctor reported ${structured.warningCount} warning(s) and 0 failure(s)`,
        };
      }
      return {
        name: "codex_doctor",
        status: "pass",
        message: "codex doctor passed",
      };
    }

    if (structured.failingChecks.every((check) => check.id.startsWith("terminal."))) {
      return {
        name: "codex_doctor",
        status: "warn",
        message: `codex doctor reported terminal-only failure: ${structured.failingChecks.map((check) => check.summary).join("; ")}`,
      };
    }

    return {
      name: "codex_doctor",
      status: "fail",
      message: `codex doctor failed: ${structured.failingChecks.map((check) => `${check.id}: ${check.summary}`).join("; ")}`,
    };
  }

  return commandCheck("codex_doctor", result, "codex doctor passed", "codex doctor failed");
}

function parseCodexDoctorSummary(text: string): { failingChecks: Array<{ id: string; summary: string }>; warningCount: number } | undefined {
  try {
    const parsed = JSON.parse(text) as {
      checks?: unknown;
    };
    if (!parsed.checks || typeof parsed.checks !== "object" || Array.isArray(parsed.checks)) return undefined;

    const failingChecks: Array<{ id: string; summary: string }> = [];
    let warningCount = 0;
    for (const [id, rawCheck] of Object.entries(parsed.checks)) {
      if (!rawCheck || typeof rawCheck !== "object" || Array.isArray(rawCheck)) continue;
      const check = rawCheck as { status?: unknown; summary?: unknown };
      const status = typeof check.status === "string" ? check.status.toLowerCase() : "";
      const summary = typeof check.summary === "string" && check.summary ? check.summary : id;
      if (status === "fail" || status === "error") {
        failingChecks.push({ id, summary });
      } else if (status === "warning" || status === "warn") {
        warningCount += 1;
      }
    }

    return { failingChecks, warningCount };
  } catch {
    return undefined;
  }
}

function parseSkillwikiDoctorSummary(text: string): { ok: boolean; warningCount: number; errorCount: number } | undefined {
  try {
    const parsed = JSON.parse(text) as {
      ok?: unknown;
      data?: {
        summary?: {
          warn?: unknown;
          error?: unknown;
        };
      };
    };
    if (typeof parsed.ok !== "boolean") return undefined;
    const summary = parsed.data?.summary;
    if (!summary) return undefined;
    const warn = summary.warn;
    const error = summary.error;
    return {
      ok: parsed.ok,
      warningCount: typeof warn === "number" ? warn : 0,
      errorCount: typeof error === "number" ? error : parsed.ok ? 0 : 1,
    };
  } catch {
    return undefined;
  }
}

function rateLimitCheck(result: { exitCode: number; stdout: string; stderr: string }): DoctorCheck {
  if (result.exitCode !== 0) {
    return {
      name: "gh_rate_limit",
      status: "fail",
      message: `gh api rate_limit failed: ${firstOutputLine(result.stderr || result.stdout)}`,
    };
  }

  try {
    const parsed = JSON.parse(result.stdout) as {
      resources?: {
        core?: { remaining?: unknown };
        search?: { remaining?: unknown };
      };
    };
    const coreRemaining = parsed.resources?.core?.remaining;
    const searchRemaining = parsed.resources?.search?.remaining;
    if (typeof coreRemaining !== "number" || typeof searchRemaining !== "number") {
      return {
        name: "gh_rate_limit",
        status: "fail",
        message: "gh api rate_limit did not include core/search remaining counts",
      };
    }
    if (coreRemaining <= 0 || searchRemaining <= 0) {
      return {
        name: "gh_rate_limit",
        status: "fail",
        message: `GitHub rate limit exhausted (core=${coreRemaining}, search=${searchRemaining})`,
      };
    }
    return {
      name: "gh_rate_limit",
      status: "pass",
      message: `GitHub rate limit available (core=${coreRemaining}, search=${searchRemaining})`,
    };
  } catch (error) {
    return {
      name: "gh_rate_limit",
      status: "fail",
      message: `gh api rate_limit returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function gitCleanCheck(result: { exitCode: number; stdout: string; stderr: string }): DoctorCheck {
  if (result.exitCode !== 0) {
    return {
      name: "vault_git_clean",
      status: "fail",
      message: `git status failed: ${firstOutputLine(result.stderr || result.stdout)}`,
    };
  }
  const status = result.stdout.trim();
  if (status) {
    return {
      name: "vault_git_clean",
      status: "fail",
      message: `vault working tree is dirty: ${firstOutputLine(status)}`,
    };
  }
  return {
    name: "vault_git_clean",
    status: "pass",
    message: "vault working tree is clean",
  };
}

function firstOutputLine(text: string): string {
  return text.trim().split(/\r?\n/, 1)[0] || "no output";
}

function shortSha(value: string): string {
  return value.slice(0, 7);
}

function stringifyDetail(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

async function nodePrint(runCommand: CommandRunner, repo: string, expression: string): Promise<Result<string>> {
  const result = await runCommand(process.execPath, ["-p", expression], { cwd: repo });
  if (result.exitCode !== 0) return err("COMMAND_FAILED", firstOutputLine(result.stderr || result.stdout));
  const value = result.stdout.trim();
  return value ? ok(value) : err("COMMAND_FAILED", "empty version output");
}

async function gitShowPackageVersion(runCommand: CommandRunner, repo: string, path: string): Promise<Result<string>> {
  const result = await runCommand("git", ["-C", repo, "show", `origin/main:${path}`], { cwd: repo });
  if (result.exitCode !== 0) return err("COMMAND_FAILED", firstOutputLine(result.stderr || result.stdout));
  try {
    const parsed = JSON.parse(result.stdout) as { version?: unknown };
    return typeof parsed.version === "string" && parsed.version ? ok(parsed.version) : err("COMMAND_FAILED", `${path} has no version`);
  } catch (error) {
    return err("COMMAND_FAILED", error instanceof Error ? error.message : String(error));
  }
}

function compareVersions(left: string, right: string): number {
  const parsedLeft = parseVersion(left);
  const parsedRight = parseVersion(right);
  if (!parsedLeft || !parsedRight) return left.localeCompare(right);

  for (const key of ["major", "minor", "patch"] as const) {
    if (parsedLeft[key] !== parsedRight[key]) return parsedLeft[key] - parsedRight[key];
  }
  if (!parsedLeft.prerelease && parsedRight.prerelease) return 1;
  if (parsedLeft.prerelease && !parsedRight.prerelease) return -1;
  return (parsedLeft.prerelease ?? "").localeCompare(parsedRight.prerelease ?? "", undefined, { numeric: true });
}

function parseVersion(value: string): { major: number; minor: number; patch: number; prerelease?: string } | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(value);
  if (!match) return undefined;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4],
  };
}

function readSessionBriefGeneratedAts(
  vault: string,
  context: AgentMemoryTrendsContext
): Array<{ generatedAt?: Date; raw?: string; source: string }> {
  return [
    readSessionBriefJsonGeneratedAt(vault, context),
    readSessionBriefMarkdownGeneratedAt(vault, context),
  ];
}

function readSessionBriefJsonGeneratedAt(
  vault: string,
  context: AgentMemoryTrendsContext
): { generatedAt?: Date; raw?: string; source: string } {
  const source = ".skillwiki/session-brief.json";
  const cachePath = join(vault, ".skillwiki", "session-brief.json");
  const cache = readTextIfExists(cachePath, context);
  if (!cache) return { source };
  try {
    const parsed = JSON.parse(cache) as { generated_at?: unknown };
    if (typeof parsed.generated_at === "string") {
      const date = parseDate(parsed.generated_at);
      if (date) return { generatedAt: date, raw: parsed.generated_at, source };
    }
  } catch {
    return { source };
  }
  return { source };
}

function readSessionBriefMarkdownGeneratedAt(
  vault: string,
  context: AgentMemoryTrendsContext
): { generatedAt?: Date; raw?: string; source: string } {
  const source = "meta/latest-session-brief.md";
  const metaPath = join(vault, "meta", "latest-session-brief.md");
  const meta = readTextIfExists(metaPath, context);
  const match = meta?.match(/^generated_at:\s*["']?([^"'\n]+)["']?\s*$/m);
  if (!match) return { source };
  const date = parseDate(match[1]);
  return date ? { generatedAt: date, raw: match[1], source } : { source };
}

function hasGeneratedAt(brief: { generatedAt?: Date; raw?: string; source: string }): brief is { generatedAt: Date; raw: string; source: string } {
  return Boolean(brief.generatedAt && brief.raw);
}

function readLatestAgentMemoryRunAt(
  vault: string,
  context: AgentMemoryTrendsContext
): { generatedAt: Date; raw: string; source: string } | undefined {
  const latestRunPath = join(vault, ".skillwiki", "agent-memory-trends", "latest-run.json");
  const latestRun = readTextIfExists(latestRunPath, context);
  if (latestRun) {
    try {
      const parsed = JSON.parse(latestRun) as {
        finished_at?: unknown;
        finishedAt?: unknown;
        started_at?: unknown;
        startedAt?: unknown;
        run_date?: unknown;
        runDate?: unknown;
      };
      const raw =
        stringValue(parsed.finished_at) ??
        stringValue(parsed.finishedAt) ??
        stringValue(parsed.started_at) ??
        stringValue(parsed.startedAt) ??
        runDateToHktStart(stringValue(parsed.run_date) ?? stringValue(parsed.runDate));
      const date = raw ? parseDate(raw) : undefined;
      if (date && raw) return { generatedAt: date, raw, source: ".skillwiki/agent-memory-trends/latest-run.json" };
    } catch {
      // Fall through to the digest filename fallback below.
    }
  }

  try {
    const entries = readdirSync(join(vault, "queries"), { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name.match(/^(\d{4}-\d{2}-\d{2})-agent-memory-trends-digest\.md$/)?.[1])
      .filter((date): date is string => Boolean(date))
      .sort();
    const latestDate = entries.at(-1);
    const raw = runDateToHktStart(latestDate);
    const date = raw ? parseDate(raw) : undefined;
    return date && raw ? { generatedAt: date, raw, source: "queries/*-agent-memory-trends-digest.md" } : undefined;
  } catch {
    return undefined;
  }
}

function readTextIfExists(path: string, context: AgentMemoryTrendsContext): string | undefined {
  const pathExists = context.pathExists ?? existsSync;
  if (!pathExists(path)) return undefined;
  try {
    return context.readFile ? context.readFile(path) : readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

function parseDate(value: string): Date | undefined {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return undefined;
  return new Date(timestamp);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function runDateToHktStart(value: string | undefined): string | undefined {
  return value ? `${value}T00:00:00+08:00` : undefined;
}

function formatBriefSources(briefs: Array<{ raw: string; source: string }>): string {
  return briefs.map((brief) => `${brief.source} generated_at ${brief.raw}`).join("; ");
}

function formatAgedBriefSources(briefs: Array<{ ageHours: number; raw: string; source: string }>): string {
  return briefs
    .map((brief) => `${brief.source} ${Math.max(0, Math.floor(brief.ageHours))}h old (generated_at ${brief.raw})`)
    .join("; ");
}

function parseCliOptions(argv: string[]): ParsedCliOptions {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg?.startsWith("--")) continue;
    const withoutPrefix = arg.slice(2);
    const eq = withoutPrefix.indexOf("=");
    if (eq >= 0) {
      values.set(withoutPrefix.slice(0, eq), withoutPrefix.slice(eq + 1));
      continue;
    }
    const next = argv[index + 1];
    if (next && !next.startsWith("-")) {
      values.set(withoutPrefix, next);
      index += 1;
    } else {
      flags.add(withoutPrefix);
    }
  }
  return { values, flags };
}

async function collectInput(options: ParsedCliOptions, context: AgentMemoryTrendsContext): Promise<Result<CollectedInput>> {
  const resolved = resolveRunOptions(options, context);
  const config = loadResearchConfig(resolved.configPath, context);
  if (!config.ok) return config;

  const runner = context.runGh ?? createGhRunner(context.cwd);
  const collector = context.collectGithubCandidates ?? collectGithubCandidates;
  const collection = await collector(config.data, {
    runGh: runner,
    now: context.now,
  });
  if (!collection.ok) return err("COLLECTOR_FAILED", collection.detail ?? collection.error);

  const signalCollector = context.collectDuplicateSignals ?? collectDuplicateSignals;
  const signals = signalCollector(resolved.vault, resolved.project);
  if (!signals.ok) return signals;

  const input = buildAgentInput({
    vault: resolved.vault,
    repo: resolved.repo,
    project: resolved.project,
    runDate: resolved.runDate,
    runId: resolved.runId,
    selectedCandidates: collection.data.selectedCandidates,
    allowedOutputs: buildAllowedOutputs(resolved.runDate, resolved.runId),
    duplicateSignals: signals.data,
  });
  if (!input.ok) return input;

  const writer = context.writeAgentInput ?? writeAgentInput;
  const written = writer(input.data);
  if (!written.ok) return written;

  return ok({
    options: resolved,
    config: config.data,
    input: input.data,
    inputPath: written.data.path,
  });
}

async function runDaily(
  options: ParsedCliOptions,
  context: AgentMemoryTrendsContext,
  dryRun: boolean,
  generateOnly: boolean,
  previewOnly: boolean
): Promise<Result<{ mutations: string[]; selectedCandidateCount: number }>> {
  const startedAt = formatInstant(context.now);
  if (!dryRun && !generateOnly && !previewOnly) {
    const resolved = resolveRunOptions(options, context);
    const recovered = await cleanGeneratedPreflightLeftovers(resolved, context);
    if (!recovered.ok) {
      writeFailureState(resolved, context, startedAt, classifyFailure(recovered.error));
      return recovered;
    }
    const synced = await syncVaultBeforeLiveDaily(resolved, context);
    if (!synced.ok) {
      writeFailureState(resolved, context, startedAt, classifyFailure(synced.error));
      return synced;
    }
  }

  const collected = await collectInput(options, context);
  if (!collected.ok) return collected;

  if (previewOnly) {
    const preview = materializePreviewRun({
      vault: collected.data.options.vault,
      runDate: collected.data.options.runDate,
      inputPath: `.skillwiki/agent-memory-trends/${collected.data.options.runDate}-input.json`,
      input: collected.data.input,
    });
    if (!preview.ok) return preview;
    return ok({
      mutations: [collected.data.inputPath, ...preview.data.changedFiles],
      selectedCandidateCount: collected.data.input.selectedCandidates.length,
    });
  }

  if (isQuietRunInput(collected.data.input)) {
    return runQuietDaily(options, context, dryRun, generateOnly, collected.data, startedAt);
  }

  const tmpDir = join(tmpdir(), "agent-memory-trends");
  mkdirSync(tmpDir, { recursive: true });
  const synthesisInput = {
    input: collected.data.input,
    tmpDir,
    outputLastMessagePath: join(tmpDir, `${collected.data.options.runDate}-codex-last-message.md`),
  };
  const synthesis = context.runSynthesis
    ? await context.runSynthesis(synthesisInput)
    : await createDefaultSynthesisRunner(options, context)(synthesisInput);
  if (!synthesis.ok) {
    writeFailureState(collected.data.options, context, startedAt, "agent");
    return err("AGENT_FAILED", synthesis.detail ?? synthesis.error);
  }

  let changedFiles: string[] = [];
  let heartbeat: HeartbeatState = { status: "skipped", reason: dryRun ? "dry-run" : "generate-only" };
  const mutations = [collected.data.inputPath];

  if (!dryRun) {
    const renderer = context.renderProposalCaptures ?? renderProposalCaptures;
    const rendered = renderer({
      vault: collected.data.options.vault,
      project: collected.data.options.project,
      runDate: collected.data.options.runDate,
      manifestPath: collected.data.input.manifestPath,
      output: synthesis.data.output,
      duplicateSignals: {
        existingTasks: collected.data.input.existingTasks,
        activeWork: collected.data.input.activeWork,
        recentDigests: collected.data.input.recentDigests,
      },
    });
    if (!rendered.ok) {
      writeFailureState(collected.data.options, context, startedAt, "validation");
      return rendered;
    }

    let refreshed: RefreshSessionBriefOutput = { filesWritten: [] };
    if (!generateOnly) {
      const refresher = context.refreshSessionBrief ?? ((input) => refreshSessionBrief(input, context));
      const refreshResult = await refresher({
        vault: collected.data.options.vault,
        repo: collected.data.options.repo,
        project: collected.data.options.project,
      });
      if (!refreshResult.ok) {
        writeFailureState(collected.data.options, context, startedAt, "validation");
        return refreshResult;
      }
      refreshed = refreshResult.data;
    }

    if (generateOnly) {
      const materialized = materializeOperationalRunManifest({
        vault: collected.data.options.vault,
        runDate: collected.data.options.runDate,
        manifestPath: collected.data.input.manifestPath,
        extraChangedFiles: [
          vaultRelativePath(collected.data.options.vault, collected.data.inputPath),
          ...rendered.data.renderedPaths,
          ...refreshed.filesWritten,
        ],
      });
      if (!materialized.ok) {
        writeFailureState(collected.data.options, context, startedAt, "validation");
        return materialized;
      }
      changedFiles = materialized.data.changedFiles;
      mutations.push(...changedFiles);
      return ok({
        mutations,
        selectedCandidateCount: collected.data.input.selectedCandidates.length,
      });
    }

    const published = await runPublish(options, context, false);
    if (!published.ok) {
      writeFailureState(collected.data.options, context, startedAt, classifyFailure(published.error));
      return published;
    }
    changedFiles = published.data.mutations;
    mutations.push(...changedFiles);
    heartbeat = published.data.heartbeat;
  }

  if (dryRun) {
    const state = context.writeRunState ?? writeRunState;
    const stateResult = state(collected.data.options.vault, {
      runDate: collected.data.options.runDate,
      runId: collected.data.options.runId,
      status: "success",
      startedAt,
      finishedAt: formatInstant(context.now),
      selectedCandidateCount: collected.data.input.selectedCandidates.length,
      taskCaptureCount: 0,
      changedFiles,
      failureClass: null,
      heartbeat,
    });
    if (!stateResult.ok) return stateResult;
    mutations.push(stateResult.data.runStatePath, stateResult.data.latestRunPath);
  }

  return ok({
    mutations,
    selectedCandidateCount: collected.data.input.selectedCandidates.length,
  });
}

async function runQuietDaily(
  options: ParsedCliOptions,
  context: AgentMemoryTrendsContext,
  dryRun: boolean,
  generateOnly: boolean,
  collected: CollectedInput,
  startedAt: string
): Promise<Result<{ mutations: string[]; selectedCandidateCount: number }>> {
  const changedFiles = quietRunChangedFiles(collected.options, collected.inputPath);
  const heartbeat: HeartbeatState = dryRun
    ? { status: "skipped", reason: "dry-run" }
    : generateOnly
      ? { status: "skipped", reason: "generate-only" }
      : { status: "skipped", reason: "publish heartbeat pending" };
  const state = context.writeRunState ?? writeRunState;
  const stateResult = state(collected.options.vault, {
    runDate: collected.options.runDate,
    runId: collected.options.runId,
    status: "success",
    startedAt,
    finishedAt: formatInstant(context.now),
    selectedCandidateCount: 0,
    taskCaptureCount: 0,
    changedFiles,
    failureClass: null,
    heartbeat,
  });
  if (!stateResult.ok) return stateResult;

  const mutations = [collected.inputPath];
  if (dryRun || generateOnly) {
    return ok({
      mutations: [...mutations, ...changedFiles],
      selectedCandidateCount: 0,
    });
  }

  const published = await runPublish(options, context, false);
  if (!published.ok) {
    writeFailureState(collected.options, context, startedAt, classifyFailure(published.error));
    return published;
  }

  return ok({
    mutations: [...mutations, ...published.data.mutations],
    selectedCandidateCount: 0,
  });
}

function isQuietRunInput(input: AgentInput): boolean {
  return input.selectedCandidates.length === 0;
}

function quietRunChangedFiles(options: ResolvedRunOptions, inputPath: string): string[] {
  return [
    vaultRelativePath(options.vault, inputPath),
    options.manifestPath,
    ".skillwiki/agent-memory-trends/latest-run.json",
  ].sort((left, right) => left.localeCompare(right));
}

function dailyModeLabel(dryRun: boolean, generateOnly: boolean, previewOnly: boolean): string {
  if (dryRun) return " (dry-run)";
  if (previewOnly) return " (generate-only preview)";
  if (generateOnly) return " (generate-only)";
  return "";
}

function vaultRelativePath(vault: string, path: string): string {
  const prefix = vault.endsWith("/") ? vault : `${vault}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

const AGENT_MEMORY_RUN_STATE_RE = /^\.skillwiki\/agent-memory-trends\/(?:latest-run|\d{4}-\d{2}-\d{2}-(?:input|run))\.json$/;

interface DirtyVaultPaths {
  tracked: string[];
  untracked: string[];
}

async function cleanGeneratedPreflightLeftovers(
  options: ResolvedRunOptions,
  context: AgentMemoryTrendsContext
): Promise<Result<{ cleaned: true }>> {
  const runCommand = context.runCommand ?? createCommandRunner();
  const status = await runCommand("git", ["-C", options.vault, "status", "--porcelain", "--untracked-files=all"], { cwd: options.repo });
  if (status.exitCode !== 0) {
    return err("GIT_FAILED", {
      args: ["-C", options.vault, "status", "--porcelain", "--untracked-files=all"],
      stderr: status.stderr,
      stdout: status.stdout,
    });
  }

  const dirty = parseDirtyVaultPaths(status.stdout);
  const dirtyPaths = [...dirty.tracked, ...dirty.untracked];
  if (dirtyPaths.length === 0) return ok({ cleaned: true });

  const unrelated = dirtyPaths.filter((path) => !AGENT_MEMORY_RUN_STATE_RE.test(path));
  if (unrelated.length > 0) {
    return err("DIRTY_PREFLIGHT", {
      message: "vault has dirty files outside generated agent-memory-trends run state",
      dirtyFiles: unrelated,
    });
  }

  if (dirty.tracked.length > 0) {
    const restoreArgs = ["-C", options.vault, "restore", "--source=HEAD", "--staged", "--worktree", "--", ...dirty.tracked];
    const restored = await runCommand("git", restoreArgs, { cwd: options.repo });
    if (restored.exitCode !== 0) {
      return err("GIT_FAILED", {
        args: restoreArgs,
        stderr: restored.stderr,
        stdout: restored.stdout,
      });
    }
  }

  if (dirty.untracked.length > 0) {
    const cleaned = await runCommand("git", ["-C", options.vault, "clean", "-f", "--", ...dirty.untracked], { cwd: options.repo });
    if (cleaned.exitCode !== 0) {
      return err("GIT_FAILED", {
        args: ["-C", options.vault, "clean", "-f", "--", ...dirty.untracked],
        stderr: cleaned.stderr,
        stdout: cleaned.stdout,
      });
    }
  }

  return ok({ cleaned: true });
}

function parseDirtyVaultPaths(stdout: string): DirtyVaultPaths {
  const dirty: DirtyVaultPaths = { tracked: [], untracked: [] };
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const path = pathFromPorcelainLine(line);
    if (!path) continue;
    if (line.startsWith("?? ")) {
      dirty.untracked.push(path);
    } else {
      dirty.tracked.push(path);
    }
  }
  return dirty;
}

function pathFromPorcelainLine(line: string): string | undefined {
  if (line.length < 4) return undefined;
  const path = line.slice(3).trim();
  const renameSeparator = " -> ";
  return path.includes(renameSeparator) ? path.slice(path.lastIndexOf(renameSeparator) + renameSeparator.length) : path;
}

async function syncVaultBeforeLiveDaily(
  options: ResolvedRunOptions,
  context: AgentMemoryTrendsContext
): Promise<Result<{ synced: true }>> {
  const runCommand = context.runCommand ?? createCommandRunner();
  const result = await runCommand("git", ["-C", options.vault, "pull", "--rebase", "origin", "main"], { cwd: options.repo });
  if (result.exitCode !== 0) {
    return err("GIT_FAILED", {
      args: ["-C", options.vault, "pull", "--rebase", "origin", "main"],
      stderr: result.stderr,
      stdout: result.stdout,
    });
  }
  return ok({ synced: true });
}

async function refreshSessionBrief(
  input: RefreshSessionBriefInput,
  context: AgentMemoryTrendsContext
): Promise<Result<RefreshSessionBriefOutput>> {
  const runCommand = context.runCommand ?? createCommandRunner();
  const lastOp = snapshotLastOp(input.vault);
  let restoreError: unknown;
  const result = await runCommand(
    "skillwiki",
    ["session-brief", input.vault, "--project", input.project, "--write"],
    { cwd: input.repo, env: { AUTO_COMMIT: "false" } }
  ).finally(() => {
    try {
      restoreLastOp(lastOp);
    } catch (error) {
      restoreError = error;
    }
  });
  if (restoreError) {
    return err("SESSION_BRIEF_LAST_OP_RESTORE_FAILED", restoreError instanceof Error ? restoreError.message : String(restoreError));
  }
  if (result.exitCode !== 0) {
    return err("SESSION_BRIEF_FAILED", {
      stderr: result.stderr,
      stdout: result.stdout,
    });
  }
  return ok({ filesWritten: SESSION_BRIEF_FILES });
}

function snapshotLastOp(vault: string): LastOpSnapshot {
  const path = join(vault, ".skillwiki", "last-op.json");
  if (!existsSync(path)) return { path, existed: false, body: "" };
  return { path, existed: true, body: readFileSync(path, "utf8") };
}

function restoreLastOp(snapshot: LastOpSnapshot): void {
  if (snapshot.existed) {
    writeFileSync(snapshot.path, snapshot.body, "utf8");
    return;
  }

  try {
    unlinkSync(snapshot.path);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
}

async function runPublish(
  options: ParsedCliOptions,
  context: AgentMemoryTrendsContext,
  dryRun: boolean
): Promise<Result<{ mutations: string[]; heartbeat: HeartbeatState }>> {
  const resolved = resolveRunOptions(options, context);
  if (dryRun) {
    return ok({
      mutations: [],
      heartbeat: { status: "skipped", reason: "dry-run" },
    });
  }

  const existingRawPaths = context.listTrackedRawPaths
    ? await context.listTrackedRawPaths(resolved.vault)
    : await listTrackedRawPaths(resolved.vault, context);
  if (!existingRawPaths.ok) return existingRawPaths;

  const publisher = context.publishGeneratedChanges ?? publishGeneratedChanges;
  const published = await publisher({
    vault: resolved.vault,
    runDate: resolved.runDate,
    manifestPath: resolved.manifestPath,
    acquireLock: async () => ok({ release: async () => undefined }),
    git: createGitRunner(resolved.vault),
    skillwiki: createSkillwikiRunner(resolved.vault),
    existingRawPaths: existingRawPaths.data,
  });
  if (!published.ok) return published;

  const heartbeatResult = await (context.maybeSendHeartbeat ?? maybeSendHeartbeat)({
    enabled: true,
    url: context.env.AGENT_MEMORY_TRENDS_HEARTBEAT_URL,
    pushSucceeded: true,
  });
  if (!heartbeatResult.ok) return err("HEARTBEAT_FAILED", heartbeatResult.detail ?? heartbeatResult.error);

  return ok({
    mutations: published.data.changedFiles,
    heartbeat: heartbeatResult.data,
  });
}

async function listTrackedRawPaths(vault: string, context: AgentMemoryTrendsContext): Promise<Result<string[]>> {
  const runCommand = context.runCommand ?? createCommandRunner();
  const result = await runCommand("git", ["-C", vault, "ls-files", "--", "raw/articles", "raw/transcripts"], { cwd: vault });
  if (result.exitCode !== 0) {
    return err("GIT_FAILED", {
      args: ["-C", vault, "ls-files", "--", "raw/articles", "raw/transcripts"],
      stderr: result.stderr,
      stdout: result.stdout,
    });
  }
  return ok(result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
}

function loadResearchConfig(path: string, context: AgentMemoryTrendsContext): Result<ResearchConfig> {
  if (!context.readFile) return readResearchConfig(path);
  return parseResearchConfig(context.readFile(path), path);
}

function resolveRunOptions(options: ParsedCliOptions, context: AgentMemoryTrendsContext): ResolvedRunOptions {
  const vault = options.values.get("vault") ?? context.env.AGENT_MEMORY_TRENDS_VAULT ?? join(context.cwd, "wiki");
  const repo = options.values.get("repo") ?? context.env.AGENT_MEMORY_TRENDS_REPO ?? context.cwd;
  const project = options.values.get("project") ?? context.env.SKILLWIKI_PROJECT ?? DEFAULT_PROJECT;
  const configPath =
    options.values.get("config") ??
    context.env.AGENT_MEMORY_TRENDS_CONFIG ??
    join(vault, "projects", project, "architecture", "agent-memory-research-sources.yaml");
  const runDate = options.values.get("date") ?? formatDateInTimezone(context.now, DEFAULT_TIMEZONE);
  const runId = options.values.get("run-id") ?? formatRunIdInTimezone(context.now, DEFAULT_TIMEZONE);
  const manifestPath = options.values.get("manifest") ?? `.skillwiki/agent-memory-trends/${runDate}-run.json`;
  return { vault, repo, project, configPath, runDate, runId, manifestPath };
}

function buildAllowedOutputs(runDate: string, runId: string): AllowedOutputs {
  const safeRunId = runId.replace(/[^A-Za-z0-9.+-]/g, "-");
  return {
    evidencePath: `raw/articles/${runDate}-agent-memory-trends-evidence-${safeRunId}.md`,
    digestPath: `queries/${runDate}-agent-memory-trends-digest.md`,
    taskCaptureGlob: `raw/transcripts/${runDate}-task-*.md`,
    manifestPath: `.skillwiki/agent-memory-trends/${runDate}-run.json`,
  };
}

function createGhRunner(cwd: string) {
  return (args: string[]) =>
    new Promise<{ exitCode: number; stdout: string; stderr: string }>((resolve) => {
      execFile("gh", args, { cwd, encoding: "utf8" }, (error, stdout, stderr) => {
        resolve({
          exitCode: typeof error?.code === "number" ? error.code : error ? 1 : 0,
          stdout,
          stderr,
        });
      });
    });
}

function createCodexRunner() {
  return (args: string[], options: { stdin: string; cwd: string; timeoutMs?: number }) =>
    new Promise<{ exitCode: number; stdout: string; stderr: string }>((resolve) => {
      const child = execFile("codex", args, { cwd: options.cwd, encoding: "utf8", timeout: options.timeoutMs }, (error, stdout, stderr) => {
        resolve({
          exitCode: typeof error?.code === "number" ? error.code : error ? 1 : 0,
          stdout,
          stderr: stderr || (error ? error.message : ""),
        });
      });
      child.stdin?.end(options.stdin);
    });
}

function createClaudeRunner() {
  return (args: string[], options: { stdin: string; cwd: string; timeoutMs?: number }) =>
    new Promise<{ exitCode: number; stdout: string; stderr: string }>((resolve) => {
      const child = execFile("claude", args, { cwd: options.cwd, encoding: "utf8", timeout: options.timeoutMs }, (error, stdout, stderr) => {
        resolve({
          exitCode: typeof error?.code === "number" ? error.code : error ? 1 : 0,
          stdout,
          stderr: stderr || (error ? error.message : ""),
        });
      });
      child.stdin?.end(options.stdin);
    });
}

function createDefaultSynthesisRunner(options: ParsedCliOptions, context: AgentMemoryTrendsContext) {
  const runtime = resolveSynthesisRuntimeOptions(options.values, context.env);
  const primary = createCodexSynthesisRunner(createCodexRunner(), { timeoutMs: runtime.timeoutMs });
  const fallback =
    runtime.fallback === "claude" && commandAvailable("claude", context.env)
      ? createClaudeSynthesisRunner(createClaudeRunner(), { timeoutMs: runtime.timeoutMs })
      : undefined;
  return createFallbackSynthesisRunner({
    primary,
    fallback,
    primaryRetries: runtime.primaryRetries,
  });
}

function commandAvailable(command: string, env: Record<string, string | undefined>): boolean {
  const pathValue = env.PATH ?? process.env.PATH ?? "";
  for (const dir of pathValue.split(":")) {
    if (!dir) continue;
    try {
      accessSync(join(dir, command), constants.X_OK);
      return true;
    } catch {
      // Keep searching PATH.
    }
  }
  return false;
}

function createCommandRunner(): CommandRunner {
  return (command, args, options) =>
    new Promise<{ exitCode: number; stdout: string; stderr: string }>((resolve) => {
      const env = options.env ? { ...process.env, ...options.env } : undefined;
      execFile(command, args, { cwd: options.cwd, encoding: "utf8", env }, (error, stdout, stderr) => {
        resolve({
          exitCode: typeof error?.code === "number" ? error.code : error ? 1 : 0,
          stdout,
          stderr,
        });
      });
    });
}

function okRun(
  command: AgentMemoryTrendsCommand,
  dryRun: boolean,
  generatedAt: string,
  mutations: string[],
  humanHint: string,
  checks?: DoctorCheck[]
): CliRunResult<AgentMemoryTrendsCommandResult> {
  return {
    exitCode: 0,
    result: ok({
      command,
      status: "ok",
      dryRun,
      generatedAt,
      mutations,
      humanHint,
      checks,
    }),
  };
}

function errorRun<T>(result: Result<T>): CliRunResult<AgentMemoryTrendsCommandResult> {
  return {
    exitCode: 1,
    result: result.ok ? err("COMMAND_FAILED") : result,
  };
}

function writeFailureState(
  options: ResolvedRunOptions,
  context: AgentMemoryTrendsContext,
  startedAt: string,
  failureClass: AgentMemoryTrendRunState["failureClass"]
): void {
  const state = context.writeRunState ?? writeRunState;
  state(options.vault, {
    runDate: options.runDate,
    runId: options.runId,
    status: "failure",
    startedAt,
    finishedAt: formatInstant(context.now),
    selectedCandidateCount: 0,
    taskCaptureCount: 0,
    changedFiles: [],
    failureClass,
    heartbeat: { status: "skipped", reason: `${failureClass ?? "unknown"} failed` },
  });
}

function classifyFailure(error: string): AgentMemoryTrendRunState["failureClass"] {
  if (error === "DIRTY_PREFLIGHT") return "dirty_preflight";
  if (error === "HEARTBEAT_FAILED") return "heartbeat";
  if (error === "VALIDATION_FAILED") return "validation";
  if (error === "ALLOWLIST_REJECTED") return "allowlist";
  if (error === "GIT_FAILED") return "push";
  return "validation";
}

function formatInstant(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function formatDateInTimezone(date: Date, timeZone: string): string {
  const parts = dateParts(date, timeZone);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function formatRunIdInTimezone(date: Date, timeZone: string): string {
  const parts = dateParts(date, timeZone);
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}-${parts.minute}-${parts.second}+08-00`;
}

function dateParts(date: Date, timeZone: string): Record<"year" | "month" | "day" | "hour" | "minute" | "second", string> {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const entries = formatter.formatToParts(date).map((part) => [part.type, part.value]);
  const map = Object.fromEntries(entries);
  return {
    year: map.year,
    month: map.month,
    day: map.day,
    hour: map.hour === "24" ? "00" : map.hour,
    minute: map.minute,
    second: map.second,
  };
}

async function main(): Promise<void> {
  const run = await runAgentMemoryTrendsCli(process.argv.slice(2));
  process.stdout.write(JSON.stringify(run.result) + "\n");
  process.exit(run.exitCode);
}

export function isDirectCliInvocation(metaUrl: string, argvPath = process.argv[1]): boolean {
  if (!argvPath) return false;
  const modulePath = fileURLToPath(metaUrl);
  try {
    return realpathSync(modulePath) === realpathSync(argvPath);
  } catch {
    return modulePath === argvPath;
  }
}

if (isDirectCliInvocation(import.meta.url)) {
  void main();
}
