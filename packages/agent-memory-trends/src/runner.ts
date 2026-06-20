import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { agentInputToWire, type AgentInput } from "./input.js";
import { parseSynthesisOutput, type SynthesisOutput, type SynthesisRunner } from "./synthesis.js";
import { err, ok, type Result } from "./types.js";

export const DEFAULT_SYNTHESIS_RETRIES = 1;
export const DEFAULT_SYNTHESIS_TIMEOUT_MS = 20 * 60 * 1000;
export const SYNTHESIS_FALLBACK_MODES = ["claude", "none"] as const;
export type SynthesisFallbackMode = (typeof SYNTHESIS_FALLBACK_MODES)[number];

export interface SynthesisRuntimeOptions {
  primaryRetries: number;
  fallback: SynthesisFallbackMode;
  timeoutMs: number;
}

export interface CodexRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface CodexRunnerOptions {
  stdin: string;
  cwd: string;
  timeoutMs?: number;
}

export type CodexRunner = (args: string[], options: CodexRunnerOptions) => Promise<CodexRunResult>;
export type ClaudeRunner = (args: string[], options: CodexRunnerOptions) => Promise<CodexRunResult>;

export interface BuildCodexExecRequestInput {
  input: AgentInput;
  tmpDir: string;
  outputLastMessagePath: string;
}

export interface CodexExecRequest {
  args: string[];
  stdin: string;
  cwd: string;
  timeoutMs?: number;
}

export interface ClaudePrintRequest extends CodexExecRequest {
  outputLastMessagePath: string;
}

export interface RunCodexSynthesisInput extends BuildCodexExecRequestInput {
  runCodex: CodexRunner;
  timeoutMs?: number;
}

export interface RunClaudeSynthesisInput extends BuildCodexExecRequestInput {
  runClaude: ClaudeRunner;
  timeoutMs?: number;
}

export interface RunCodexSynthesisOutput {
  manifestPath: string;
  outputLastMessagePath: string;
  stdout: string;
  stderr: string;
  output: SynthesisOutput;
}

export interface FallbackSynthesisRunnerOptions {
  primary: SynthesisRunner;
  fallback?: SynthesisRunner;
  primaryRetries?: number;
}

export function createCodexSynthesisRunner(runCodex: CodexRunner, options: { timeoutMs?: number } = {}): SynthesisRunner {
  return (request) => runCodexSynthesis({ ...request, runCodex, timeoutMs: options.timeoutMs });
}

export function createClaudeSynthesisRunner(runClaude: ClaudeRunner, options: { timeoutMs?: number } = {}): SynthesisRunner {
  return (request) => runClaudeSynthesis({ ...request, runClaude, timeoutMs: options.timeoutMs });
}

export function createFallbackSynthesisRunner(options: FallbackSynthesisRunnerOptions): SynthesisRunner {
  const primaryRetries = normalizeRetryCount(options.primaryRetries);
  return async (request) => {
    let primaryError: Result<RunCodexSynthesisOutput> | undefined;
    for (let attempt = 0; attempt <= primaryRetries; attempt += 1) {
      const result = await options.primary(request);
      if (result.ok) return result;
      primaryError = result;
    }

    if (!options.fallback) {
      return primaryError ?? err("SYNTHESIS_RUNNER_FAILED", "primary runner failed without an error detail");
    }

    const fallback = await options.fallback(request);
    if (fallback.ok) return fallback;
    return err("SYNTHESIS_FALLBACK_FAILED", {
      primaryAttempts: primaryRetries + 1,
      primaryError,
      fallbackError: fallback,
    });
  };
}

export function resolveSynthesisRuntimeOptions(
  values: Map<string, string>,
  env: Record<string, string | undefined>
): SynthesisRuntimeOptions {
  return {
    primaryRetries: parseNonNegativeInteger(
      values.get("synthesis-retries") ?? env.AGENT_MEMORY_TRENDS_SYNTHESIS_RETRIES,
      DEFAULT_SYNTHESIS_RETRIES
    ),
    fallback: parseFallbackMode(
      values.get("synthesis-fallback") ?? env.AGENT_MEMORY_TRENDS_SYNTHESIS_FALLBACK,
      "claude"
    ),
    timeoutMs: parsePositiveInteger(
      values.get("synthesis-timeout-ms") ?? env.AGENT_MEMORY_TRENDS_SYNTHESIS_TIMEOUT_MS,
      DEFAULT_SYNTHESIS_TIMEOUT_MS
    ),
  };
}

export function loadCodexSynthesisPrompt(): string {
  const srcDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(srcDir, "..", "prompts", "codex-synthesis.md"),
    join(process.cwd(), "packages", "agent-memory-trends", "prompts", "codex-synthesis.md"),
  ];
  const promptPath = candidates.find((path) => existsSync(path));
  if (!promptPath) throw new Error("codex synthesis prompt not found");
  return readFileSync(promptPath, "utf8");
}

export function buildCodexExecRequest(input: BuildCodexExecRequestInput): CodexExecRequest {
  return {
    args: [
      "--search",
      "--ask-for-approval",
      "never",
      "exec",
      "--sandbox",
      "workspace-write",
      "--cd",
      input.input.vault,
      "--add-dir",
      input.input.repo,
      "--add-dir",
      input.tmpDir,
      "--output-last-message",
      input.outputLastMessagePath,
      "-",
    ],
    stdin: buildSynthesisStdin(input.input),
    cwd: input.input.vault,
  };
}

export function buildClaudePrintRequest(input: BuildCodexExecRequestInput): ClaudePrintRequest {
  return {
    args: [
      "--print",
      "--permission-mode",
      "bypassPermissions",
      "--input-format",
      "text",
      "--output-format",
      "text",
      "--add-dir",
      input.input.repo,
      "--add-dir",
      input.tmpDir,
    ],
    stdin: buildSynthesisStdin(input.input),
    cwd: input.input.vault,
    outputLastMessagePath: input.outputLastMessagePath,
  };
}

export async function runCodexSynthesis(input: RunCodexSynthesisInput): Promise<Result<RunCodexSynthesisOutput>> {
  const request = buildCodexExecRequest(input);
  const result = await input.runCodex(request.args, {
    stdin: request.stdin,
    cwd: request.cwd,
    timeoutMs: input.timeoutMs ?? DEFAULT_SYNTHESIS_TIMEOUT_MS,
  });
  if (result.exitCode !== 0) return err("CODEX_RUN_FAILED", result.stderr || result.stdout);

  const manifestPath = join(input.input.vault, input.input.manifestPath);
  if (!existsSync(manifestPath)) {
    return err("CODEX_MANIFEST_MISSING", { manifestPath });
  }
  if (!existsSync(input.outputLastMessagePath)) {
    return err("CODEX_LAST_MESSAGE_MISSING", { outputLastMessagePath: input.outputLastMessagePath });
  }

  const output = readSynthesisOutput(input.outputLastMessagePath);

  return ok({
    manifestPath,
    outputLastMessagePath: input.outputLastMessagePath,
    stdout: result.stdout,
    stderr: result.stderr,
    output,
  });
}

export async function runClaudeSynthesis(input: RunClaudeSynthesisInput): Promise<Result<RunCodexSynthesisOutput>> {
  const request = buildClaudePrintRequest(input);
  const result = await input.runClaude(request.args, {
    stdin: request.stdin,
    cwd: request.cwd,
    timeoutMs: input.timeoutMs ?? DEFAULT_SYNTHESIS_TIMEOUT_MS,
  });
  if (result.exitCode !== 0) return err("CLAUDE_RUN_FAILED", result.stderr || result.stdout);

  writeFileSync(request.outputLastMessagePath, result.stdout, "utf8");

  const manifestPath = join(input.input.vault, input.input.manifestPath);
  if (!existsSync(manifestPath)) {
    return err("CLAUDE_MANIFEST_MISSING", { manifestPath });
  }
  if (!existsSync(input.outputLastMessagePath)) {
    return err("CLAUDE_LAST_MESSAGE_MISSING", { outputLastMessagePath: input.outputLastMessagePath });
  }

  return ok({
    manifestPath,
    outputLastMessagePath: input.outputLastMessagePath,
    stdout: result.stdout,
    stderr: result.stderr,
    output: readSynthesisOutput(input.outputLastMessagePath),
  });
}

function buildSynthesisStdin(input: AgentInput): string {
  return [
    loadCodexSynthesisPrompt().trimEnd(),
    "",
    "BEGIN_AGENT_MEMORY_TRENDS_INPUT_JSON",
    JSON.stringify(agentInputToWire(input), null, 2),
    "END_AGENT_MEMORY_TRENDS_INPUT_JSON",
    "",
  ].join("\n");
}

function normalizeRetryCount(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_SYNTHESIS_RETRIES;
  return Math.max(0, Math.floor(value));
}

function parseNonNegativeInteger(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.floor(parsed));
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

function parseFallbackMode(value: string | undefined, fallback: SynthesisFallbackMode): SynthesisFallbackMode {
  if (value === undefined || value.trim() === "") return fallback;
  return SYNTHESIS_FALLBACK_MODES.includes(value as SynthesisFallbackMode)
    ? (value as SynthesisFallbackMode)
    : fallback;
}

function readSynthesisOutput(outputLastMessagePath: string): SynthesisOutput {
  if (!existsSync(outputLastMessagePath)) return { proposals: [] };
  const parsed = parseSynthesisOutput(readFileSync(outputLastMessagePath, "utf8"));
  if (parsed.ok) return parsed.data;
  return {
    proposals: [],
    proposalErrors: [typeof parsed.detail === "string" ? parsed.detail : parsed.error],
  };
}
