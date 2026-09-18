import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { RawSourceSchema } from "@skillwiki/shared";
import { extractFrontmatter } from "../../../cli/src/parsers/frontmatter.js";
import {
  canonicalEventJson,
  eventPathFor,
  validateLogEvent,
  type SkillwikiLogEventV1,
} from "../../../cli/src/utils/log-events.js";
import { renderLogEventBody, renderLogEventMarker } from "../../../cli/src/utils/log-projection.js";
import { operationId } from "../../../cli/src/utils/operation-id.js";
import { scanSensitiveContent } from "../../../cli/src/utils/sensitive-content.js";
import { validateTypedTarget } from "../../../cli/src/utils/typed-page.js";
import { isAllowedWritePath } from "../allowlist.js";
import { appendAudit } from "../audit.js";
import { ReconcileGate } from "../reconcile.js";
import { commitCasWrite, commitWrite, sha256Bytes, S3PutError, type PutObject } from "../txn.js";
import { type GetObject } from "../versions.js";

const LOG_APPEND_NAMESPACE = "skillwiki-mcp-log-append-v1";
const OPERATION_ID_RE = /^[0-9a-f]{64}$/;

export const CAPTURE_KINDS = ["task", "idea", "bug", "note"] as const;
const PROJECT_SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

export function normalizeCaptureProject(raw: string | undefined): string | null {
  const slug = (raw ?? "").trim().replace(/^\[\[|\]\]$/g, "");
  if (!slug || !PROJECT_SLUG_RE.test(slug)) return null;
  return slug;
}

export function vaultHasProject(vaultDir: string, slug: string): boolean {
  try {
    return statSync(join(vaultDir, "projects", slug)).isDirectory();
  } catch {
    return false;
  }
}
export type CaptureKind = (typeof CAPTURE_KINDS)[number];

export interface WriteContext {
  vaultDir: string;
  vaultId?: string;
  hostId: string;
  gate: ReconcileGate;
  putObject: PutObject;
  getObject?: GetObject;
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
  path?: string;
  currentVersion?: string;
};

export type OverwriteSuccess = { ok: true; path: string };

export type CaptureSuccess = { ok: true; path: string; writer_id: string };
export type LogSuccess = {
  ok: true;
  path: "log.md";
  appended: boolean;
  operation_id: string;
  event_path: string;
  appended_sha256: string;
  event_sha256: string;
  log_sha256: string;
  s3_verified: true;
  projection_repaired?: boolean;
};

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
  files: { relPath: string; content: string }[],
): Promise<ToolFailure | null> {
  try {
    await commitWrite(
      { vaultDir: ctx.vaultDir, vaultId: ctx.vaultId, putObject: ctx.putObject, onCommit: ctx.onCommit },
      files,
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
      vault_id: ctx.vaultId,
      tool,
      path: files[0]?.relPath,
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
  if (!input.title?.trim() || !input.content?.trim()) {
    return fail("USAGE", "project, title, and content are required");
  }
  const project = normalizeCaptureProject(input.project);
  if (!project) return fail("USAGE", "project must be a vault project slug");
  if (!vaultHasProject(ctx.vaultDir, project)) return fail("USAGE", "unknown project");

  const combined = `${input.title}\n${input.content}\n${input.agent_note ?? ""}`;
  const sensitive = scanSensitiveContent(combined, { file: "wiki_capture" });
  if (sensitive.length > 0) {
    appendAudit(ctx.auditFile, {
      host_id: ctx.hostId,
      vault_id: ctx.vaultId,
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
    project,
    title: input.title,
    content: input.content,
    date,
    agent_note: input.agent_note,
  });
  const fm = extractFrontmatter(content);
  if (!fm.ok) return fail("INVALID_FRONTMATTER");
  const schema = RawSourceSchema.safeParse(fm.data);
  if (!schema.success) return fail("SCHEMA", schema.error.issues[0]?.message);

  const writeFail = await commitOrFail(ctx, started, "wiki_capture", [{ relPath, content }]);
  if (writeFail) return writeFail;

  appendAudit(ctx.auditFile, {
    host_id: ctx.hostId,
    vault_id: ctx.vaultId,
    tool: "wiki_capture",
    path: relPath,
    ok: true,
    ms: Date.now() - started,
  });
  return { ok: true, path: relPath, writer_id: ctx.hostId };
}

type ExistingEvent = { body: Buffer; fromS3: boolean };

async function readExistingEvent(
  ctx: WriteContext,
  eventPath: string,
): Promise<ExistingEvent | null> {
  if (ctx.getObject) {
    try {
      const got = await ctx.getObject(eventPath);
      if (got?.body) return { body: got.body, fromS3: true };
    } catch {
      return null;
    }
  }
  try {
    return { body: await readFile(join(ctx.vaultDir, ...eventPath.split("/"))), fromS3: false };
  } catch {
    return null;
  }
}

async function verifyEventGetObject(
  ctx: WriteContext,
  eventPath: string,
  eventSha256: string,
  known?: ExistingEvent,
): Promise<ToolFailure | null> {
  if (!ctx.getObject) {
    return fail("S3_VERIFY_FAILED", "event GetObject is required for wiki_log_append");
  }
  try {
    const got = known?.fromS3 ? known : await ctx.getObject(eventPath);
    if (!got?.body) {
      return fail("S3_VERIFY_FAILED", "event object missing after write");
    }
    if (sha256Bytes(got.body) !== eventSha256) {
      return fail("S3_VERIFY_FAILED", "event GetObject hash mismatch");
    }
    return null;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return fail("S3_VERIFY_FAILED", message);
  }
}

function logAppendReceipt(input: {
  appended: boolean;
  operationId: string;
  eventPath: string;
  appendedSha: string;
  eventSha: string;
  logText: string;
  repaired?: boolean;
}): LogSuccess {
  const receipt: LogSuccess = {
    ok: true,
    path: "log.md",
    appended: input.appended,
    operation_id: input.operationId,
    event_path: input.eventPath,
    appended_sha256: input.appendedSha,
    event_sha256: input.eventSha,
    log_sha256: sha256Bytes(Buffer.from(input.logText, "utf8")),
    s3_verified: true,
  };
  if (input.repaired) receipt.projection_repaired = true;
  return receipt;
}

function buildLogAppendEvent(input: {
  date: string;
  hostId: string;
  operationId: string;
  exactBlock: string;
}): SkillwikiLogEventV1 {
  return {
    schema: "skillwiki-log-event/v1",
    operation_id: input.operationId,
    occurred_at: `${input.date}T00:00:00.000Z`,
    host_id: input.hostId,
    actor: "skillwiki-mcp",
    kind: "log-append",
    target: "log.md",
    note: "mcp log-append",
    metadata: { appended_markdown: input.exactBlock },
  };
}

export async function wikiLogAppend(
  ctx: WriteContext,
  input: { content: string; operation_id?: string },
): Promise<LogSuccess | ToolFailure> {
  const started = Date.now();
  const blocked = notReady(ctx);
  if (blocked) return blocked;

  const body = (input.content ?? "").trim();
  if (!body) return fail("USAGE", "content is required");
  const clientOp = input.operation_id?.trim();
  if (clientOp && !OPERATION_ID_RE.test(clientOp)) {
    return fail("USAGE", "operation_id must be 64 lowercase hex chars");
  }

  const sensitive = scanSensitiveContent(body, { file: "log.md" });
  if (sensitive.length > 0) {
    appendAudit(ctx.auditFile, {
      host_id: ctx.hostId,
      vault_id: ctx.vaultId,
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
  const exactBlock = body.startsWith("## [") ? body : `## [${date}] ${body}`;
  const opId = clientOp || operationId(LOG_APPEND_NAMESPACE, [date, exactBlock]);
  const event = buildLogAppendEvent({
    date,
    hostId: ctx.hostId,
    operationId: opId,
    exactBlock,
  });
  const validated = validateLogEvent(event);
  if (!validated.ok) {
    const detail = validated.detail as { message?: string } | undefined;
    return fail(validated.error, detail?.message ?? "invalid log-event record");
  }
  const eventJson = canonicalEventJson(validated.data);
  const eventPath = eventPathFor(validated.data);
  if (!isAllowedWritePath(eventPath, "log_append")) return fail("PATH_DENIED", eventPath);

  const projected = renderLogEventBody(validated.data);
  const marker = renderLogEventMarker(validated.data);
  const appendedSha = sha256Bytes(Buffer.from(exactBlock, "utf8"));
  const eventSha = sha256Bytes(Buffer.from(eventJson, "utf8"));

  const existingEvent = await readExistingEvent(ctx, eventPath);
  if (existingEvent) {
    if (existingEvent.body.toString("utf8") !== eventJson) {
      appendAudit(ctx.auditFile, {
        host_id: ctx.hostId,
        vault_id: ctx.vaultId,
        tool: "wiki_log_append",
        path: eventPath,
        ok: false,
        error: "EVENT_IDENTITY_COLLISION",
        ms: Date.now() - started,
      });
      return fail("EVENT_IDENTITY_COLLISION", eventPath);
    }
    const verifyFail = await verifyEventGetObject(ctx, eventPath, eventSha, existingEvent);
    if (verifyFail) return verifyFail;

    let logText = existing;
    let repaired = false;
    if (!existing.includes(marker)) {
      logText = `${existing.replace(/\s+$/, "")}\n\n${projected}\n`;
      const writeFail = await commitOrFail(ctx, started, "wiki_log_append", [
        { relPath: "log.md", content: logText },
      ]);
      if (writeFail) return writeFail;
      repaired = true;
    }
    appendAudit(ctx.auditFile, {
      host_id: ctx.hostId,
      vault_id: ctx.vaultId,
      tool: "wiki_log_append",
      path: "log.md",
      ok: true,
      ms: Date.now() - started,
    });
    return logAppendReceipt({
      appended: false,
      operationId: opId,
      eventPath,
      appendedSha,
      eventSha,
      logText,
      repaired,
    });
  }

  const next = `${existing.replace(/\s+$/, "")}\n\n${projected}\n`;
  const writeFail = await commitOrFail(ctx, started, "wiki_log_append", [
    { relPath: eventPath, content: eventJson },
    { relPath: "log.md", content: next },
  ]);
  if (writeFail) return writeFail;

  const verifyFail = await verifyEventGetObject(ctx, eventPath, eventSha);
  if (verifyFail) return verifyFail;

  appendAudit(ctx.auditFile, {
    host_id: ctx.hostId,
    vault_id: ctx.vaultId,
    tool: "wiki_log_append",
    path: "log.md",
    ok: true,
    ms: Date.now() - started,
  });
  return logAppendReceipt({
    appended: true,
    operationId: opId,
    eventPath,
    appendedSha,
    eventSha,
    logText: next,
  });
}

export interface OverwriteInput {
  path: string;
  content: string;
  base_sha256?: string;
}

async function wikiOverwrite(
  ctx: WriteContext,
  tool: "wiki_workitem_write" | "wiki_page_publish",
  kind: "workitem" | "page_publish",
  input: OverwriteInput,
): Promise<OverwriteSuccess | ToolFailure> {
  const started = Date.now();
  const blocked = notReady(ctx);
  if (blocked) return blocked;

  const relPath = (input.path ?? "").trim().replace(/^\/+/, "");
  const content = input.content ?? "";
  if (!relPath || !content) return fail("USAGE", "path and content are required");
  if (!isAllowedWritePath(relPath, kind)) return fail("PATH_DENIED", relPath);
  if (kind === "page_publish") {
    const validated = validateTypedTarget(relPath);
    if (!validated.ok) return fail("PATH_DENIED", relPath);
  }

  const sensitive = scanSensitiveContent(content, { file: relPath });
  if (sensitive.length > 0) {
    appendAudit(ctx.auditFile, {
      host_id: ctx.hostId,
      vault_id: ctx.vaultId,
      tool,
      path: relPath,
      ok: false,
      error: "SENSITIVE_CONTENT_DETECTED",
      ms: Date.now() - started,
    });
    return fail("SENSITIVE_CONTENT_DETECTED");
  }

  try {
    const cas = await commitCasWrite(
      { vaultDir: ctx.vaultDir, vaultId: ctx.vaultId, putObject: ctx.putObject, getObject: ctx.getObject, onCommit: ctx.onCommit },
      { relPath, content },
      input.base_sha256,
    );
    if (!cas.ok) {
      appendAudit(ctx.auditFile, {
        host_id: ctx.hostId,
        vault_id: ctx.vaultId,
        tool,
        path: relPath,
        ok: false,
        error: cas.error,
        ms: Date.now() - started,
      });
      if (cas.error === "FILE_CHANGED") {
        return { ok: false, error: cas.error, currentVersion: cas.currentVersion, path: cas.path };
      }
      return fail(cas.error, cas.message);
    }
  } catch (error: unknown) {
    const code =
      error instanceof S3PutError || (error as { code?: string }).code === "S3_PUT_FAILED"
        ? "S3_PUT_FAILED"
        : "WRITE_FAILED";
    const message = error instanceof Error ? error.message : String(error);
    appendAudit(ctx.auditFile, {
      host_id: ctx.hostId,
      vault_id: ctx.vaultId,
      tool,
      path: relPath,
      ok: false,
      error: code,
      ms: Date.now() - started,
    });
    return fail(code, message);
  }

  appendAudit(ctx.auditFile, {
    host_id: ctx.hostId,
    vault_id: ctx.vaultId,
    tool,
    path: relPath,
    ok: true,
    ms: Date.now() - started,
  });
  return { ok: true, path: relPath };
}

export function wikiWorkitemWrite(
  ctx: WriteContext,
  input: OverwriteInput,
): Promise<OverwriteSuccess | ToolFailure> {
  return wikiOverwrite(ctx, "wiki_workitem_write", "workitem", input);
}

export function wikiPagePublish(
  ctx: WriteContext,
  input: OverwriteInput,
): Promise<OverwriteSuccess | ToolFailure> {
  return wikiOverwrite(ctx, "wiki_page_publish", "page_publish", input);
}
