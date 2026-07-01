import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface McpAuditEntry {
  ts: string;
  tool: string;
  vault?: string;
  ok: boolean;
  exitCode?: number;
  ms: number;
  error?: string;
}

function auditEnabled(): boolean {
  const v = process.env.SKILLWIKI_MCP_AUDIT;
  if (v === "0" || v === "false") return false;
  return true;
}

function auditSink(): "stderr" | "file" {
  return process.env.SKILLWIKI_MCP_AUDIT_FILE ? "file" : "stderr";
}

function auditFilePath(): string {
  const custom = process.env.SKILLWIKI_MCP_AUDIT_FILE;
  if (custom && custom.length > 0) return custom;
  return join(homedir(), ".skillwiki", "mcp-audit.jsonl");
}

/** Structured one-line JSON audit (stderr default; optional file via SKILLWIKI_MCP_AUDIT_FILE). */
export function auditMcpToolCall(entry: Omit<McpAuditEntry, "ts">): void {
  if (!auditEnabled()) return;
  const line = JSON.stringify({ ...entry, ts: new Date().toISOString() }) + "\n";
  if (auditSink() === "stderr") {
    process.stderr.write(`[skillwiki-mcp-audit] ${line}`);
    return;
  }
  const path = auditFilePath();
  mkdirSync(join(path, ".."), { recursive: true });
  appendFileSync(path, line, "utf8");
}

export async function runMcpToolHandler(
  tool: string,
  input: { vault?: string; wiki?: string },
  fn: () => Promise<{
    content: Array<{ type: "text"; text: string }>;
    isError?: boolean;
    _meta?: { exitCode: number };
  }>,
): Promise<{
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  _meta?: { exitCode: number };
}> {
  const started = Date.now();
  try {
    const out = await fn();
    auditMcpToolCall({
      tool,
      vault: input.vault,
      ok: !out.isError,
      exitCode: out._meta?.exitCode,
      ms: Date.now() - started,
    });
    return out;
  } catch (e: unknown) {
    auditMcpToolCall({
      tool,
      vault: input.vault,
      ok: false,
      ms: Date.now() - started,
      error: String(e),
    });
    throw e;
  }
}