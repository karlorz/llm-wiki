import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { RawSourceSchema } from "@skillwiki/shared";
import { extractFrontmatter } from "../../../cli/src/parsers/frontmatter.js";
import { scanSensitiveContent } from "../../../cli/src/utils/sensitive-content.js";
import { isAllowedWritePath } from "../allowlist.js";
import { appendAudit } from "../audit.js";
import { ReconcileGate } from "../reconcile.js";
import { commitWrite, S3PutError, type PutObject } from "../txn.js";

export type CaptureKind = "task" | "idea" | "bug" | "note";

export interface WriteContext {
  vaultDir: string;
  hostId: string;
  gate: ReconcileGate;
  putObject: PutObject;
  now?: () => Date;
  onCommit?: (paths: string[]) => void;
  auditFile?: string;
}

export interface CaptureInput {
  kind: CaptureKind;
  project: string;
  title: string;
  content: string;
  agent_note?: string;
}

export type ToolFailure = {
  ok: false;
  error: string;
  message?: string;
};

export type CaptureSuccess = { ok: true; path: string };
export type LogSuccess = { ok: true; path: "log.md"; appended: true };

export function slugify(title: string): string {
  const words = title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 6);
  return words.join("-").replace(/-+/g, "-") || "capture";
}

export function renderCaptureMarkdown(input: {
  kind: CaptureKind;
  project?: string;
  title: string;
  content: string;
  date: string;
  agent_note?: string;
}): string {
  const lines = [
    "---",
    "source_url: null",
    `created: ${input.date}`,
    `ingested: ${input.date}`,
    "ingested_by: manual",
    `kind: ${input.kind}`,
  ];
  if (input.project) lines.push(`project: "[[${input.project.replace(/^\[\[|\]\]$/g, "")}]]"`);
  lines.push("---", "", `# ${input.kind}: ${input.title}`, "", input.content.trim());
  if (input.agent_note?.trim()) {
    lines.push("", `> agent_note: ${input.agent_note.trim()}`);
  }
  lines.push("");
  return lines.join("\n");
}

function today(now?: () => Date): string {
  return (now ? now() : new Date()).toISOString().slice(0, 10);
}

function fail(error: string, message?: string): ToolFailure {
  return message ? { ok: false, error, message } : { ok: false, error };
}

function uniqueCapturePath(vaultDir: string, date: string, kind: CaptureKind, slug: string): string {
  const dir = "raw/transcripts";
  let candidate = `${dir}/${date}-${kind}-${slug}.md`;
  let n = 2;
  while (existsSync(join(vaultDir, ...candidate.split("/")))) {
    candidate = `${dir}/${date}-${kind}-${slug}-${n}.md`;
    n += 1;
  }
  return candidate;
}

async function commitOrFail(
  ctx: WriteContext,
  started: number,
  tool: string,
  relPath: string,
  content: string,
): Promise<ToolFailure | null> {
  try {
    await commitWrite(
      { vaultDir: ctx.vaultDir, putObject: ctx.putObject, onCommit: ctx.onCommit },
      [{ relPath, content }],
    );
    return null;
  } catch (error: unknown) {
    const code =
      error instanceof S3PutError || (error as { code?: string }).code === "S3_PUT_FAILED"
        ? "S3_PUT_FAILED"
        : "WRITE_FAILED";
    const message = error instanceof Error ? error.message : String(error);
    appendAudit(ctx.auditFile, {
      host_id: ctx.hostId,
      tool,
      path: relPath,
      ok: false,
      error: code,
      ms: Date.now() - started,
    });
    return fail(code, message);
  }
}

function notReady(ctx: WriteContext): ToolFailure | null {
  if (ctx.gate.ready) return null;
  return fail("TOOLS_NOT_READY", "tools blocked until first S3 reconcile completes");
}

export async function wikiCapture(ctx: WriteContext, input: CaptureInput): Promise<CaptureSuccess | ToolFailure> {
  const started = Date.now();
  const blocked = notReady(ctx);
  if (blocked) return blocked;

  const kinds: CaptureKind[] = ["task", "idea", "bug", "note"];
  if (!kinds.includes(input.kind)) return fail("USAGE", "kind must be task|idea|bug|note");
  if (!input.title?.trim() || !input.content?.trim() || !input.project?.trim()) {
    return fail("USAGE", "project, title, and content are required");
  }

  const combined = `${input.title}\n${input.content}\n${input.agent_note ?? ""}`;
  const sensitive = scanSensitiveContent(combined, { file: "wiki_capture" });
  if (sensitive.length > 0) {
    appendAudit(ctx.auditFile, {
      host_id: ctx.hostId,
      tool: "wiki_capture",
      ok: false,
      error: "SENSITIVE_CONTENT_DETECTED",
      ms: Date.now() - started,
    });
    return fail("SENSITIVE_CONTENT_DETECTED");
  }

  const date = today(ctx.now);
  const relPath = uniqueCapturePath(ctx.vaultDir, date, input.kind, slugify(input.title));
  if (!isAllowedWritePath(relPath, "capture")) return fail("PATH_DENIED", relPath);

  const content = renderCaptureMarkdown({
    kind: input.kind,
    project: input.project,
    title: input.title,
    content: input.content,
    date,
    agent_note: input.agent_note,
  });
  const fm = extractFrontmatter(content);
  if (!fm.ok) return fail("INVALID_FRONTMATTER");
  const schema = RawSourceSchema.safeParse(fm.data);
  if (!schema.success) return fail("SCHEMA", schema.error.issues[0]?.message);

  const writeFail = await commitOrFail(ctx, started, "wiki_capture", relPath, content);
  if (writeFail) return writeFail;

  appendAudit(ctx.auditFile, {
    host_id: ctx.hostId,
    tool: "wiki_capture",
    path: relPath,
    ok: true,
    ms: Date.now() - started,
  });
  return { ok: true, path: relPath };
}

export async function wikiLogAppend(
  ctx: WriteContext,
  input: { content: string },
): Promise<LogSuccess | ToolFailure> {
  const started = Date.now();
  const blocked = notReady(ctx);
  if (blocked) return blocked;

  const body = (input.content ?? "").trim();
  if (!body) return fail("USAGE", "content is required");
  if (!isAllowedWritePath("log.md", "log_append")) return fail("PATH_DENIED", "log.md");

  const sensitive = scanSensitiveContent(body, { file: "log.md" });
  if (sensitive.length > 0) {
    appendAudit(ctx.auditFile, {
      host_id: ctx.hostId,
      tool: "wiki_log_append",
      path: "log.md",
      ok: false,
      error: "SENSITIVE_CONTENT_DETECTED",
      ms: Date.now() - started,
    });
    return fail("SENSITIVE_CONTENT_DETECTED");
  }

  let existing: string;
  try {
    existing = await readFile(join(ctx.vaultDir, "log.md"), "utf8");
  } catch {
    return fail("FILE_NOT_FOUND", "log.md");
  }

  const date = today(ctx.now);
  const entry = body.startsWith("## [") ? body : `## [${date}] ${body}`;
  const next = `${existing.replace(/\s+$/, "")}\n\n${entry}\n`;

  const writeFail = await commitOrFail(ctx, started, "wiki_log_append", "log.md", next);
  if (writeFail) return writeFail;

  appendAudit(ctx.auditFile, {
    host_id: ctx.hostId,
    tool: "wiki_log_append",
    path: "log.md",
    ok: true,
    ms: Date.now() - started,
  });
  return { ok: true, path: "log.md", appended: true };
}
