import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { agentInputToWire, type AgentInput } from "./input.js";
import { parseSynthesisOutput, type SynthesisOutput, type SynthesisRunner } from "./synthesis.js";
import { err, ok, type Result } from "./types.js";

export interface CodexRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface CodexRunnerOptions {
  stdin: string;
  cwd: string;
}

export type CodexRunner = (args: string[], options: CodexRunnerOptions) => Promise<CodexRunResult>;

export interface BuildCodexExecRequestInput {
  input: AgentInput;
  tmpDir: string;
  outputLastMessagePath: string;
}

export interface CodexExecRequest {
  args: string[];
  stdin: string;
  cwd: string;
}

export interface RunCodexSynthesisInput extends BuildCodexExecRequestInput {
  runCodex: CodexRunner;
}

export interface RunCodexSynthesisOutput {
  manifestPath: string;
  outputLastMessagePath: string;
  stdout: string;
  stderr: string;
  output: SynthesisOutput;
}

export function createCodexSynthesisRunner(runCodex: CodexRunner): SynthesisRunner {
  return (request) => runCodexSynthesis({ ...request, runCodex });
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
  const stdin = [
    loadCodexSynthesisPrompt().trimEnd(),
    "",
    "BEGIN_AGENT_MEMORY_TRENDS_INPUT_JSON",
    JSON.stringify(agentInputToWire(input.input), null, 2),
    "END_AGENT_MEMORY_TRENDS_INPUT_JSON",
    "",
  ].join("\n");

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
    stdin,
    cwd: input.input.vault,
  };
}

export async function runCodexSynthesis(input: RunCodexSynthesisInput): Promise<Result<RunCodexSynthesisOutput>> {
  const request = buildCodexExecRequest(input);
  const result = await input.runCodex(request.args, { stdin: request.stdin, cwd: request.cwd });
  if (result.exitCode !== 0) return err("CODEX_RUN_FAILED", result.stderr || result.stdout);

  const manifestPath = join(input.input.vault, input.input.manifestPath);
  if (!existsSync(manifestPath)) {
    return err("CODEX_MANIFEST_MISSING", { manifestPath });
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

function readSynthesisOutput(outputLastMessagePath: string): SynthesisOutput {
  if (!existsSync(outputLastMessagePath)) return { proposals: [] };
  const parsed = parseSynthesisOutput(readFileSync(outputLastMessagePath, "utf8"));
  if (parsed.ok) return parsed.data;
  return {
    proposals: [],
    proposalErrors: [typeof parsed.detail === "string" ? parsed.detail : parsed.error],
  };
}
