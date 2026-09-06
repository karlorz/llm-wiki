import type { ResearchConfig } from "./config.js";
import type { DuplicateSignals } from "./dedupe.js";
import type {
  CommunityCollectionOptions,
  CommunityCollectionOutput,
  CommunityFetchClient,
} from "./discovery-community.js";
import type { DiscoveryCollectorOptions, DiscoveryCollectionOutput } from "./discovery-github.js";
import type { GhRunner, GithubCollectionOutput, GithubCollectorOptions } from "./github.js";
import type { AgentInput, WriteAgentInputOutput } from "./input.js";
import type { MaybeSendHeartbeatInput, HeartbeatResult } from "./heartbeat.js";
import type { PublishGeneratedChangesInput, PublishGeneratedChangesOutput } from "./publish.js";
import type { AgentMemoryTrendRunState, WriteRunStateOutput } from "./run-state.js";
import type { SynthesisRunner } from "./synthesis.js";
import type { RenderProposalCapturesInput, RenderProposalCapturesOutput } from "./captures.js";

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

export type AgentMemoryTrendsCommand = "doctor" | "diagnose" | "collect" | "daily" | "discover" | "publish" | "help" | "version";

export interface RefreshSessionBriefInput {
  vault: string;
  repo: string;
  project: string;
}

export interface RefreshSessionBriefOutput {
  filesWritten: string[];
}

export interface CommandRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface CommandRunOptions {
  cwd: string;
  env?: Record<string, string | undefined>;
}

export type CommandRunner = (
  command: string,
  args: string[],
  options: CommandRunOptions
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
    options: GithubCollectorOptions
  ) => Promise<Result<GithubCollectionOutput>>;
  /** Injectable sleep seam for the diagnostic-only Search quota reset wait. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable unix-milliseconds clock for the same wait; defaults to Date.now. */
  nowMs?: () => number;
  runDiscoveryCollector?: (
    config: ResearchConfig,
    options: DiscoveryCollectorOptions
  ) => Promise<Result<DiscoveryCollectionOutput>>;
  runCommunityCollection?: (
    config: ResearchConfig,
    options: CommunityCollectionOptions
  ) => Promise<Result<CommunityCollectionOutput>>;
  /** Fetch seam for the bounded community adapters; defaults to platform fetch. */
  fetchJson?: CommunityFetchClient;
  collectDuplicateSignals?: (vault: string, project: string, runDate?: string) => Result<DuplicateSignals>;
  writeAgentInput?: (input: AgentInput) => Result<WriteAgentInputOutput>;
  runSynthesis?: SynthesisRunner;
  renderProposalCaptures?: (input: RenderProposalCapturesInput) => Result<RenderProposalCapturesOutput>;
  refreshSessionBrief?: (input: RefreshSessionBriefInput) => Promise<Result<RefreshSessionBriefOutput>>;
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
    | "runner_source"
    | "runner_version"
    | "session_brief_freshness"
    | "synthesis_last_real_run"
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
