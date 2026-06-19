import { join } from "node:path";
import { err, ok, type CommandRunner, type JobCheck, type Result } from "../types.js";
import { runWriteTransaction, type WriteTransactionDetails } from "../write-transaction.js";

export interface AgentMemoryTrendsDailyInput {
  vaultPath: string;
  repoPath: string;
  project: string;
  runCommand: CommandRunner;
}

export interface AgentMemoryTrendsDailyData {
  mutations: string[];
  humanHint?: string;
}

const AGENT_MEMORY_TRENDS_ALLOWLIST = [
  ".skillwiki/agent-memory-trends/**",
  "queries/*-agent-memory-trends-digest.md",
  "raw/articles/*-agent-memory-trends-evidence*.md",
  "raw/transcripts/*-bug-*.md",
  "raw/transcripts/*-idea-*.md",
  "raw/transcripts/*-task-*.md",
  "projects/llm-wiki/architecture/agent-memory-research-sources.yaml",
];

export async function runAgentMemoryTrendsDaily(
  input: AgentMemoryTrendsDailyInput
): Promise<JobCheck<WriteTransactionDetails<AgentMemoryTrendsDailyData>>> {
  return runWriteTransaction({
    job: "agent-memory-trends-daily",
    repoPath: input.vaultPath,
    allowlist: AGENT_MEMORY_TRENDS_ALLOWLIST,
    commitMessage: "research(agent-memory): daily digest",
    runCommand: input.runCommand,
    run: async () => {
      const configPath = join(input.vaultPath, "projects", input.project, "architecture", "agent-memory-research-sources.yaml");
      const result = await input.runCommand(
        "agent-memory-trends",
        [
          "daily",
          "--generate-only",
          "--vault",
          input.vaultPath,
          "--repo",
          input.repoPath,
          "--project",
          input.project,
          "--config",
          configPath,
        ],
        {
          cwd: input.repoPath,
          env: {
            AGENT_MEMORY_TRENDS_VAULT: input.vaultPath,
            AGENT_MEMORY_TRENDS_REPO: input.repoPath,
            SKILLWIKI_PROJECT: input.project,
          },
        }
      );

      if (result.exitCode !== 0) {
        return err("AGENT_MEMORY_TRENDS_DAILY_FAILED", {
          stderr: result.stderr,
          stdout: result.stdout,
        });
      }

      const parsed = parseAgentMemoryTrendsOutput(result.stdout);
      if (!parsed.ok) return parsed;
      return ok(parsed.data);
    },
  });
}

function parseAgentMemoryTrendsOutput(stdout: string): Result<AgentMemoryTrendsDailyData> {
  try {
    const parsed = JSON.parse(extractJsonEnvelope(stdout)) as unknown;
    if (!isRecord(parsed)) return err("AGENT_MEMORY_TRENDS_OUTPUT_INVALID", "output must be a JSON object");
    if (parsed.ok !== true) return err("AGENT_MEMORY_TRENDS_DAILY_FAILED", parsed);
    const data = isRecord(parsed.data) ? parsed.data : {};
    return ok({
      mutations: stringArray(data.mutations),
      humanHint: typeof data.humanHint === "string" ? data.humanHint : undefined,
    });
  } catch (error) {
    return err("AGENT_MEMORY_TRENDS_OUTPUT_INVALID", error instanceof Error ? error.message : String(error));
  }
}

function extractJsonEnvelope(stdout: string): string {
  const direct = stdout.trim();
  if (direct.startsWith("{")) return direct;

  const jsonLine = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).reverse().find((line) => line.startsWith("{"));
  return jsonLine ?? direct;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
