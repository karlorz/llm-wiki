import { execFile } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectGithubCandidates } from "./github.js";
import { readResearchConfig, parseResearchConfig, type ResearchConfig } from "./config.js";
import { collectDuplicateSignals } from "./dedupe.js";
import { createGitRunner, createSkillwikiRunner } from "./git.js";
import { maybeSendHeartbeat } from "./heartbeat.js";
import { buildAgentInput, writeAgentInput, type AgentInput, type AllowedOutputs } from "./input.js";
import { publishGeneratedChanges } from "./publish.js";
import { runCodexSynthesis } from "./runner.js";
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
  type Result,
} from "./types.js";

const COMMANDS = new Set<AgentMemoryTrendsCommand>(["doctor", "collect", "daily", "publish"]);
const DEFAULT_PROJECT = "llm-wiki";
const DEFAULT_TIMEZONE = "Asia/Hong_Kong";

export async function runAgentMemoryTrendsCli(
  argv: string[],
  context: AgentMemoryTrendsContext = {
    cwd: process.cwd(),
    env: process.env,
    now: new Date(),
  }
): Promise<CliRunResult<AgentMemoryTrendsCommandResult>> {
  const command = argv.find((arg) => !arg.startsWith("-")) as AgentMemoryTrendsCommand | undefined;
  if (!command || !COMMANDS.has(command)) {
    return {
      exitCode: 46,
      result: err("USAGE", {
        message: "Usage: agent-memory-trends <doctor|collect|daily|publish> [--dry-run]",
      }),
    };
  }

  const options = parseCliOptions(argv);
  const dryRun = options.flags.has("dry-run");
  const generatedAt = formatInstant(context.now);

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
      const result = await runDaily(options, context, dryRun);
      if (!result.ok) return errorRun(result);
      return okRun(
        command,
        dryRun,
        generatedAt,
        result.data.mutations,
        `daily: ok${dryRun ? " (dry-run)" : ""}; selected ${result.data.selectedCandidateCount} candidate(s)`
      );
    }

    const published = await runPublish(options, context, dryRun);
    if (!published.ok) return errorRun(published);
    return okRun(command, dryRun, generatedAt, published.data.mutations, `publish: ok${dryRun ? " (dry-run)" : ""}`);
  } catch (error) {
    return errorRun(err("COMMAND_FAILED", error instanceof Error ? error.message : String(error)));
  }
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

  const codex = await runCommand("codex", ["doctor"], { cwd: resolved.repo });
  checks.push(commandCheck("codex_doctor", codex, "codex doctor passed", "codex doctor failed"));

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

function stringifyDetail(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
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
    allowedOutputs: buildAllowedOutputs(resolved.runDate),
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
  dryRun: boolean
): Promise<Result<{ mutations: string[]; selectedCandidateCount: number }>> {
  const startedAt = formatInstant(context.now);
  const collected = await collectInput(options, context);
  if (!collected.ok) return collected;

  const tmpDir = join(tmpdir(), "agent-memory-trends");
  mkdirSync(tmpDir, { recursive: true });
  const codexInput = {
    input: collected.data.input,
    tmpDir,
    outputLastMessagePath: join(tmpDir, `${collected.data.options.runDate}-codex-last-message.md`),
  };
  const codex = context.runCodexSynthesis
    ? await context.runCodexSynthesis(codexInput)
    : await runCodexSynthesis({
        ...codexInput,
        runCodex: createCodexRunner(),
      });
  if (!codex.ok) {
    writeFailureState(collected.data.options, context, startedAt, "agent");
    return err("AGENT_FAILED", codex.detail ?? codex.error);
  }

  let changedFiles: string[] = [];
  let heartbeat: HeartbeatState = { status: "skipped", reason: "dry-run" };
  const mutations = [collected.data.inputPath];

  if (!dryRun) {
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

  const publisher = context.publishGeneratedChanges ?? publishGeneratedChanges;
  const published = await publisher({
    vault: resolved.vault,
    runDate: resolved.runDate,
    manifestPath: resolved.manifestPath,
    acquireLock: async () => ok({ release: async () => undefined }),
    git: createGitRunner(resolved.vault),
    skillwiki: createSkillwikiRunner(resolved.vault),
    existingRawPaths: [],
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

function buildAllowedOutputs(runDate: string): AllowedOutputs {
  return {
    evidencePath: `raw/articles/${runDate}-agent-memory-trends-evidence.md`,
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
  return (args: string[], options: { stdin: string; cwd: string }) =>
    new Promise<{ exitCode: number; stdout: string; stderr: string }>((resolve) => {
      const child = execFile("codex", args, { cwd: options.cwd, encoding: "utf8" }, (error, stdout, stderr) => {
        resolve({
          exitCode: typeof error?.code === "number" ? error.code : error ? 1 : 0,
          stdout,
          stderr,
        });
      });
      child.stdin?.end(options.stdin);
    });
}

function createCommandRunner(): CommandRunner {
  return (command, args, options) =>
    new Promise<{ exitCode: number; stdout: string; stderr: string }>((resolve) => {
      execFile(command, args, { cwd: options.cwd, encoding: "utf8" }, (error, stdout, stderr) => {
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

if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href) {
  void main();
}
