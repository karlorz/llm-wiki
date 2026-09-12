import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { runMemoryRecall } from "../../../cli/src/commands/memory.js";
import { runQuery } from "../../../cli/src/commands/query.js";
import { runStatus } from "../../../cli/src/commands/status.js";
import { extractFrontmatter } from "../../../cli/src/parsers/frontmatter.js";
import { resolveWithinVault } from "../allowlist.js";
import { ReconcileGate, ToolsNotReadyError } from "../reconcile.js";

export interface ReadContext {
  vaultDir: string;
  gate: ReconcileGate;
  s3Ok?: boolean;
}

function notReady(): { ok: false; error: "TOOLS_NOT_READY"; message: string } {
  return { ok: false, error: "TOOLS_NOT_READY", message: "tools blocked until first S3 reconcile completes" };
}

function ensureReady(gate: ReconcileGate): { ok: false; error: "TOOLS_NOT_READY"; message: string } | null {
  try {
    gate.assertReady();
    return null;
  } catch (error: unknown) {
    if (error instanceof ToolsNotReadyError) return notReady();
    throw error;
  }
}

export async function handleWikiQuery(
  ctx: ReadContext,
  input: { query: string; limit?: number; include_pending?: boolean },
) {
  const blocked = ensureReady(ctx.gate);
  if (blocked) return blocked;
  const result = await runQuery({
    vault: ctx.vaultDir,
    text: input.query,
    limit: input.limit,
    includePending: input.include_pending,
  });
  if (!result.result.ok) {
    return { ok: false as const, error: result.result.error, detail: result.result };
  }
  return { ok: true as const, ...result.result.data };
}

export async function handleWikiReadPage(ctx: ReadContext, input: { path: string }) {
  const blocked = ensureReady(ctx.gate);
  if (blocked) return blocked;
  const abs = resolveWithinVault(ctx.vaultDir, input.path);
  if (!abs) return { ok: false as const, error: "PATH_DENIED", path: input.path };
  let bytes: Buffer;
  try {
    bytes = await readFile(abs);
  } catch {
    return { ok: false as const, error: "FILE_NOT_FOUND", path: input.path };
  }
  const markdown = bytes.toString("utf8");
  const fm = extractFrontmatter(markdown);
  return {
    ok: true as const,
    path: input.path,
    markdown,
    frontmatter: fm.ok ? fm.data : {},
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

export async function handleWikiMemoryRecall(
  ctx: ReadContext,
  input: { project: string; topic: string; scope?: "project" | "global" | "all" },
) {
  const blocked = ensureReady(ctx.gate);
  if (blocked) return blocked;
  const result = await runMemoryRecall({
    vault: ctx.vaultDir,
    project: input.project,
    topic: input.topic,
    scope: input.scope,
  });
  if (!result.result.ok) {
    return { ok: false as const, error: result.result.error, detail: result.result };
  }
  return { ok: true as const, ...result.result.data };
}

export async function handleWikiStatus(ctx: ReadContext & { s3Ok?: boolean }) {
  const blocked = ensureReady(ctx.gate);
  if (blocked) return blocked;
  const result = await runStatus({
    vault: ctx.vaultDir,
    home: process.env.HOME ?? "",
    langEnvValue: process.env.WIKI_LANG,
  });
  const base = result.result.ok ? result.result.data : { humanHint: "status failed" };
  return {
    ok: true as const,
    vault_path: ctx.vaultDir,
    reconcile_ready: ctx.gate.ready,
    s3_ok: ctx.s3Ok ?? true,
    ...(typeof base === "object" ? base : {}),
  };
}

export function vaultFile(vaultDir: string, rel: string): string {
  return join(vaultDir, ...rel.split("/"));
}
