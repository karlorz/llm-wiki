import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { agentInputToWire, type AgentInput } from "./input.js";
import {
  parseSynthesisOutput,
  type SynthesisBackend,
  type SynthesisOutput,
  type SynthesisRunner,
  type SynthesisTelemetry,
} from "./synthesis.js";
import { err, ok, type ErrResult, type Result } from "./types.js";

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
  synthesis?: SynthesisTelemetry;
}

export interface FallbackSynthesisRunnerOptions {
  primary: SynthesisRunner;
  fallback?: SynthesisRunner;
  primaryRetries?: number;
  primaryBackend?: SynthesisBackend;
  fallbackBackend?: SynthesisBackend | null;
  fallbackAvailable?: boolean;
}

export function createCodexSynthesisRunner(runCodex: CodexRunner, options: { timeoutMs?: number } = {}): SynthesisRunner {
  return (request) => runCodexSynthesis({ ...request, runCodex, timeoutMs: options.timeoutMs });
}

export function createClaudeSynthesisRunner(runClaude: ClaudeRunner, options: { timeoutMs?: number } = {}): SynthesisRunner {
  return (request) => runClaudeSynthesis({ ...request, runClaude, timeoutMs: options.timeoutMs });
}

export function createFallbackSynthesisRunner(options: FallbackSynthesisRunnerOptions): SynthesisRunner {
  const primaryRetries = normalizeRetryCount(options.primaryRetries);
  const primaryBackend = options.primaryBackend ?? "codex";
  const fallbackBackend = options.fallbackBackend ?? (options.fallback ? "claude" : null);
  const fallbackAvailable = options.fallbackAvailable ?? Boolean(options.fallback);
  return async (request) => {
    let primaryError: ErrResult | undefined;
    for (let attempt = 0; attempt <= primaryRetries; attempt += 1) {
      const result = await options.primary(request);
      if (result.ok) {
        return ok({
          ...result.data,
          synthesis: synthesisTelemetry({
            primaryBackend,
            primaryAttempts: attempt + 1,
            primaryFailed: false,
            fallbackBackend,
            fallbackAvailable,
            fallbackInvoked: false,
            resultBackend: primaryBackend,
          }),
        });
      }
      primaryError = result;
    }

    if (!options.fallback) {
      return err(primaryError?.error ?? "SYNTHESIS_RUNNER_FAILED", {
        primaryAttempts: primaryRetries + 1,
        primaryError,
        synthesis: synthesisTelemetry({
          primaryBackend,
          primaryAttempts: primaryRetries + 1,
          primaryFailed: true,
          fallbackBackend,
          fallbackAvailable,
          fallbackInvoked: false,
          resultBackend: null,
          failureCode: primaryError?.error ?? "SYNTHESIS_RUNNER_FAILED",
          primaryErrorCode: primaryError?.error ?? null,
        }),
      });
    }

    const fallback = await options.fallback(request);
    if (fallback.ok) {
      return ok({
        ...fallback.data,
        synthesis: synthesisTelemetry({
          primaryBackend,
          primaryAttempts: primaryRetries + 1,
          primaryFailed: true,
          fallbackBackend,
          fallbackAvailable,
          fallbackInvoked: true,
          resultBackend: fallbackBackend ?? "claude",
          primaryErrorCode: primaryError?.error ?? null,
        }),
      });
    }
    return err("SYNTHESIS_FALLBACK_FAILED", {
      primaryAttempts: primaryRetries + 1,
      primaryError,
      fallbackError: fallback,
      synthesis: synthesisTelemetry({
        primaryBackend,
        primaryAttempts: primaryRetries + 1,
        primaryFailed: true,
        fallbackBackend,
        fallbackAvailable,
        fallbackInvoked: true,
        resultBackend: null,
        failureCode: "SYNTHESIS_FALLBACK_FAILED",
        primaryErrorCode: primaryError?.error ?? null,
        fallbackErrorCode: fallback.error,
      }),
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
      "--disable",
      "hooks",
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
  const output = existsSync(input.outputLastMessagePath)
    ? readSynthesisOutput(input.outputLastMessagePath)
    : recoverSynthesisOutputFromStdout(input.outputLastMessagePath, result.stdout);
  if (!output) {
    return err("CODEX_LAST_MESSAGE_MISSING", {
      outputLastMessagePath: input.outputLastMessagePath,
      stdoutTail: tail(result.stdout),
      stderrTail: tail(result.stderr),
    });
  }

  return ok({
    manifestPath,
    outputLastMessagePath: input.outputLastMessagePath,
    stdout: result.stdout,
    stderr: result.stderr,
    output: output.output,
    synthesis: synthesisTelemetry({
      primaryBackend: "codex",
      primaryAttempts: 1,
      primaryFailed: false,
      fallbackBackend: null,
      fallbackAvailable: false,
      fallbackInvoked: false,
      resultBackend: "codex",
    }),
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
    output: readSynthesisOutput(input.outputLastMessagePath).output,
    synthesis: synthesisTelemetry({
      primaryBackend: "claude",
      primaryAttempts: 1,
      primaryFailed: false,
      fallbackBackend: null,
      fallbackAvailable: false,
      fallbackInvoked: false,
      resultBackend: "claude",
    }),
  });
}

function synthesisTelemetry(
  input: Omit<SynthesisTelemetry, "invoked" | "failureCode" | "primaryErrorCode" | "fallbackErrorCode"> &
    Partial<Pick<SynthesisTelemetry, "failureCode" | "primaryErrorCode" | "fallbackErrorCode">>
): SynthesisTelemetry {
  return {
    invoked: true,
    failureCode: null,
    primaryErrorCode: null,
    fallbackErrorCode: null,
    ...input,
  };
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

interface ParsedSynthesisOutputText {
  sourceText: string;
  output: SynthesisOutput;
}

function readSynthesisOutput(outputLastMessagePath: string): ParsedSynthesisOutputText {
  const sourceText = readFileSync(outputLastMessagePath, "utf8");
  const parsed = parseSynthesisOutputText(sourceText);
  if (parsed) return parsed;
  const fallback = parseSynthesisOutput(sourceText);
  return {
    sourceText,
    output: {
      proposals: [],
      proposalErrors: [parseErrorMessage(fallback)],
    },
  };
}

function recoverSynthesisOutputFromStdout(
  outputLastMessagePath: string,
  stdout: string
): ParsedSynthesisOutputText | undefined {
  const parsed = parseSynthesisOutputText(stdout, { allowProposalErrors: false });
  if (!parsed) return undefined;
  writeFileSync(outputLastMessagePath, parsed.sourceText, "utf8");
  return parsed;
}

function parseSynthesisOutputText(
  text: string,
  options: { allowProposalErrors: boolean } = { allowProposalErrors: true }
): ParsedSynthesisOutputText | undefined {
  const direct = parseSynthesisOutput(text);
  const directOutput = parsedOutputFromResult(text, direct, options.allowProposalErrors);
  if (directOutput) return directOutput;

  for (const candidate of extractJsonObjectCandidates(text).reverse()) {
    const parsed = parseSynthesisOutput(candidate);
    const output = parsedOutputFromResult(candidate, parsed, options.allowProposalErrors);
    if (output) return output;
  }
  return undefined;
}

function parsedOutputFromResult(
  sourceText: string,
  result: Result<SynthesisOutput>,
  allowProposalErrors: boolean
): ParsedSynthesisOutputText | undefined {
  if (result.ok) return { sourceText, output: result.data };
  if (!allowProposalErrors || result.error === "SYNTHESIS_OUTPUT_INVALID") return undefined;
  return {
    sourceText,
    output: {
      proposals: [],
      proposalErrors: [parseErrorMessage(result)],
    },
  };
}

function extractJsonObjectCandidates(text: string): string[] {
  const candidates: string[] = [];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== "{") continue;
    const end = findJsonObjectEnd(text, index);
    if (end === -1) continue;
    candidates.push(text.slice(index, end + 1));
    index = end;
  }
  return candidates;
}

function findJsonObjectEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function tail(text: string, maxLength = 4000): string {
  return text.length <= maxLength ? text : text.slice(-maxLength);
}

function parseErrorMessage(result: Result<SynthesisOutput>): string {
  if (result.ok) return "SYNTHESIS_OUTPUT_INVALID";
  return typeof result.detail === "string" ? result.detail : result.error;
}
