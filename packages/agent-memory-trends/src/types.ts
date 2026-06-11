import type { ResearchConfig } from "./config.js";
import type { DuplicateSignals } from "./dedupe.js";
import type { GhRunner, GithubCollectionOutput } from "./github.js";
import type { AgentInput, WriteAgentInputOutput } from "./input.js";
import type { MaybeSendHeartbeatInput, HeartbeatResult } from "./heartbeat.js";
import type { PublishGeneratedChangesInput, PublishGeneratedChangesOutput } from "./publish.js";
import type { AgentMemoryTrendRunState, WriteRunStateOutput } from "./run-state.js";

export interface OkResult<T> {
  ok: true;
  data: T;
}

export interface ErrResult {
  ok: false;
  error: string;
  detail?: unknown;
}

export type Result<T> = OkResult<T> | ErrResult;

export function ok<T>(data: T): OkResult<T> {
  return { ok: true, data };
}

export function err(error: string, detail?: unknown): ErrResult {
  return detail === undefined ? { ok: false, error } : { ok: false, error, detail };
}

export type AgentMemoryTrendsCommand = "doctor" | "collect" | "daily" | "publish";

export interface CommandRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type CommandRunner = (
  command: string,
  args: string[],
  options: { cwd: string }
) => Promise<CommandRunResult>;

export interface AgentMemoryTrendsContext {
  cwd: string;
  env: Record<string, string | undefined>;
  now: Date;
  readFile?: (path: string) => string;
  pathExists?: (path: string) => boolean;
  runCommand?: CommandRunner;
  runGh?: GhRunner;
  collectGithubCandidates?: (
    config: ResearchConfig,
    options: { runGh: GhRunner; now: Date; knownCanonicalUrls?: string[]; existingTaskUrls?: string[] }
  ) => Promise<Result<GithubCollectionOutput>>;
  collectDuplicateSignals?: (vault: string, project: string) => Result<DuplicateSignals>;
  writeAgentInput?: (input: AgentInput) => Result<WriteAgentInputOutput>;
  runCodexSynthesis?: (input: {
    input: AgentInput;
    tmpDir: string;
    outputLastMessagePath: string;
  }) => Promise<Result<{ manifestPath: string; stdout: string; stderr: string }>>;
  publishGeneratedChanges?: (input: PublishGeneratedChangesInput) => Promise<Result<PublishGeneratedChangesOutput>>;
  listTrackedRawPaths?: (vault: string) => Promise<Result<string[]>>;
  maybeSendHeartbeat?: (input: MaybeSendHeartbeatInput) => Promise<Result<HeartbeatResult>>;
  writeRunState?: (vault: string, state: AgentMemoryTrendRunState) => Result<WriteRunStateOutput>;
}

export interface AgentMemoryTrendsCommandResult {
  command: AgentMemoryTrendsCommand;
  status: "ok";
  dryRun: boolean;
  generatedAt: string;
  mutations: string[];
  humanHint: string;
  checks?: DoctorCheck[];
}

export interface CliRunResult<T> {
  exitCode: number;
  result: Result<T>;
}

export interface DoctorCheck {
  name:
    | "config"
    | "vault_path"
    | "repo_path"
    | "gh_auth"
    | "gh_rate_limit"
    | "codex_doctor"
    | "skillwiki_doctor"
    | "vault_git_clean"
    | "vault_git_push"
    | "heartbeat_env";
  status: "pass" | "fail" | "warn";
  message: string;
}
