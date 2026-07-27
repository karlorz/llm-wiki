/**
 * Host-local publication recovery journal (outside the vault).
 *
 * Path: ~/.skillwiki/publication-operations/{vault-identity}/{operation-id}.json
 * - vault-identity: first 16 hex chars of sha256(vault realpath)
 * - directory mode 0700, file mode 0600
 * - Atomic create/update via temp + rename
 * - Monotonic phase transitions only
 * - Never stores page body, approval token, credentials, or raw log note
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { err, ok, type Result } from "@skillwiki/shared";
import { sha256Hex } from "./publication-approval.js";

export const PUBLICATION_JOURNAL_SCHEMA = "skillwiki-publication-operation-v1" as const;

export type PublicationPhase =
  | "locked"
  | "taxonomy"
  | "page"
  | "verified"
  | "project-index"
  | "unlocked"
  | "event"
  | "log"
  | "complete";

const PHASE_ORDER: readonly PublicationPhase[] = [
  "locked",
  "taxonomy",
  "page",
  "verified",
  "project-index",
  "unlocked",
  "event",
  "log",
  "complete",
] as const;

export interface PublicationIdentitySummary {
  publisher: "page" | "project-page";
  draft_sha256: string;
  target: string;
  project?: string;
  log_note_sha256: string;
  /**
   * Optional snapshot of prior at journal creation. Not required for identity
   * equality during resume (prior may become the draft hash after page write).
   */
  prior_target_sha256?: string;
}

export interface PublicationJournalRecord {
  schema: typeof PUBLICATION_JOURNAL_SCHEMA;
  operation_id: string;
  phase: PublicationPhase;
  vault_identity: string;
  identity: PublicationIdentitySummary;
  published: boolean;
  verified: boolean;
  files_changed: string[];
  updated_at: string;
}

export interface JournalPaths {
  rootDir: string;
  vaultDir: string;
  journalPath: string;
}

function phaseIndex(phase: PublicationPhase): number {
  return PHASE_ORDER.indexOf(phase);
}

export function isValidPhase(phase: string): phase is PublicationPhase {
  return (PHASE_ORDER as readonly string[]).includes(phase);
}

/** Privacy-preserving vault identity (16 hex chars of sha256 realpath). */
export function vaultIdentity(vaultPath: string): string {
  let real: string;
  try {
    real = realpathSync(vaultPath);
  } catch {
    real = vaultPath;
  }
  return sha256Hex(real).slice(0, 16);
}

export function publicationJournalRoot(home: string = process.env.HOME || homedir()): string {
  return join(home, ".skillwiki", "publication-operations");
}

export function resolveJournalPaths(
  vaultPath: string,
  operationId: string,
  home: string = process.env.HOME || homedir(),
): JournalPaths {
  const identity = vaultIdentity(vaultPath);
  const rootDir = publicationJournalRoot(home);
  const vaultDir = join(rootDir, identity);
  return {
    rootDir,
    vaultDir,
    journalPath: join(vaultDir, `${operationId}.json`),
  };
}

function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    // best-effort on platforms that ignore mode
  }
}

function atomicWriteJson(path: string, body: string): void {
  ensurePrivateDir(dirname(path));
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, body, { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(tmp, 0o600);
  } catch {
    // best-effort
  }
  renameSync(tmp, path);
  try {
    chmodSync(path, 0o600);
  } catch {
    // best-effort
  }
}

function identityEqual(a: PublicationIdentitySummary, b: PublicationIdentitySummary): boolean {
  // Omit prior_target_sha256 so resume after a verified page write still matches.
  return (
    a.publisher === b.publisher &&
    a.draft_sha256 === b.draft_sha256 &&
    a.target === b.target &&
    (a.project ?? "") === (b.project ?? "") &&
    a.log_note_sha256 === b.log_note_sha256
  );
}

function validateRecord(value: unknown): Result<PublicationJournalRecord> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return err("SCHEME_REJECTED", { message: "journal record must be an object" });
  }
  const rec = value as Record<string, unknown>;
  if (rec.schema !== PUBLICATION_JOURNAL_SCHEMA) {
    return err("SCHEME_REJECTED", { message: "unknown journal schema" });
  }
  if (typeof rec.operation_id !== "string" || !/^[0-9a-f]{64}$/.test(rec.operation_id)) {
    return err("SCHEME_REJECTED", { message: "invalid operation_id" });
  }
  if (typeof rec.phase !== "string" || !isValidPhase(rec.phase)) {
    return err("SCHEME_REJECTED", { message: "invalid phase" });
  }
  if (typeof rec.vault_identity !== "string" || !/^[0-9a-f]{16}$/.test(rec.vault_identity)) {
    return err("SCHEME_REJECTED", { message: "invalid vault_identity" });
  }
  if (typeof rec.published !== "boolean" || typeof rec.verified !== "boolean") {
    return err("SCHEME_REJECTED", { message: "published/verified must be booleans" });
  }
  if (!Array.isArray(rec.files_changed) || !rec.files_changed.every((f) => typeof f === "string")) {
    return err("SCHEME_REJECTED", { message: "files_changed must be string[]" });
  }
  if (typeof rec.updated_at !== "string") {
    return err("SCHEME_REJECTED", { message: "updated_at must be a string" });
  }
  const id = rec.identity;
  if (typeof id !== "object" || id === null || Array.isArray(id)) {
    return err("SCHEME_REJECTED", { message: "identity must be an object" });
  }
  const identity = id as Record<string, unknown>;
  if (identity.publisher !== "page" && identity.publisher !== "project-page") {
    return err("SCHEME_REJECTED", { message: "invalid identity.publisher" });
  }
  for (const field of ["draft_sha256", "target", "log_note_sha256"] as const) {
    if (typeof identity[field] !== "string") {
      return err("SCHEME_REJECTED", { message: `invalid identity.${field}` });
    }
  }
  if (
    identity.prior_target_sha256 !== undefined &&
    typeof identity.prior_target_sha256 !== "string"
  ) {
    return err("SCHEME_REJECTED", { message: "invalid identity.prior_target_sha256" });
  }
  // Forbidden sensitive fields
  for (const forbidden of ["token", "approval_token", "page_body", "content", "log_note", "credential", "password"]) {
    if (forbidden in rec || forbidden in identity) {
      return err("SCHEME_REJECTED", { message: `journal must not contain ${forbidden}` });
    }
  }

  return ok({
    schema: PUBLICATION_JOURNAL_SCHEMA,
    operation_id: rec.operation_id,
    phase: rec.phase,
    vault_identity: rec.vault_identity,
    identity: {
      publisher: identity.publisher,
      draft_sha256: identity.draft_sha256 as string,
      target: identity.target as string,
      ...(typeof identity.project === "string" ? { project: identity.project } : {}),
      log_note_sha256: identity.log_note_sha256 as string,
      ...(typeof identity.prior_target_sha256 === "string"
        ? { prior_target_sha256: identity.prior_target_sha256 }
        : {}),
    },
    published: rec.published,
    verified: rec.verified,
    files_changed: [...(rec.files_changed as string[])],
    updated_at: rec.updated_at,
  });
}

export function buildIdentitySummary(input: {
  publisher: "page" | "project-page";
  draft_sha256: string;
  target: string;
  project?: string;
  log_note: string;
  prior_target_sha256: string;
}): PublicationIdentitySummary {
  return {
    publisher: input.publisher,
    draft_sha256: input.draft_sha256,
    target: input.target,
    ...(input.publisher === "project-page" && input.project ? { project: input.project } : {}),
    log_note_sha256: sha256Hex(input.log_note),
    prior_target_sha256: input.prior_target_sha256,
  };
}

export function readPublicationJournal(
  vaultPath: string,
  operationId: string,
  home: string = process.env.HOME || homedir(),
): Result<PublicationJournalRecord | null> {
  const { journalPath } = resolveJournalPaths(vaultPath, operationId, home);
  if (!existsSync(journalPath)) return ok(null);
  let text: string;
  try {
    text = readFileSync(journalPath, "utf8");
  } catch (error: unknown) {
    return err("WRITE_FAILED", { message: `read journal failed: ${String(error)}` });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return err("SCHEME_REJECTED", { message: "malformed journal JSON" });
  }
  return validateRecord(parsed);
}

export function createPublicationJournal(
  input: {
    vaultPath: string;
    operationId: string;
    identity: PublicationIdentitySummary;
    now?: Date;
    home?: string;
  },
): Result<PublicationJournalRecord> {
  const home = input.home ?? process.env.HOME ?? homedir();
  const paths = resolveJournalPaths(input.vaultPath, input.operationId, home);
  if (existsSync(paths.journalPath)) {
    return err("WRITE_FAILED", { message: "journal already exists", path: paths.journalPath });
  }
  const record: PublicationJournalRecord = {
    schema: PUBLICATION_JOURNAL_SCHEMA,
    operation_id: input.operationId,
    phase: "locked",
    vault_identity: vaultIdentity(input.vaultPath),
    identity: input.identity,
    published: false,
    verified: false,
    files_changed: [],
    updated_at: (input.now ?? new Date()).toISOString(),
  };
  const body = `${JSON.stringify(record, null, 2)}\n`;
  try {
    ensurePrivateDir(paths.vaultDir);
    atomicWriteJson(paths.journalPath, body);
  } catch (error: unknown) {
    return err("WRITE_FAILED", { message: `create journal failed: ${String(error)}` });
  }
  return ok(record);
}

export function advancePublicationJournal(
  input: {
    vaultPath: string;
    operationId: string;
    identity: PublicationIdentitySummary;
    nextPhase: PublicationPhase;
    published?: boolean;
    verified?: boolean;
    filesChanged?: string[];
    now?: Date;
    home?: string;
  },
): Result<PublicationJournalRecord> {
  const home = input.home ?? process.env.HOME ?? homedir();
  const existing = readPublicationJournal(input.vaultPath, input.operationId, home);
  if (!existing.ok) return existing;
  if (!existing.data) {
    return err("RECOVERY_EVIDENCE_MISSING", {
      operation_id: input.operationId,
      message: "publication journal not found",
    });
  }
  const current = existing.data;
  if (!identityEqual(current.identity, input.identity)) {
    return err("APPROVAL_MISMATCH", {
      message: "journal identity does not match approved payload",
      operation_id: input.operationId,
    });
  }
  const from = phaseIndex(current.phase);
  const to = phaseIndex(input.nextPhase);
  if (to < from) {
    return err("SCHEME_REJECTED", {
      message: "phase regression refused",
      from: current.phase,
      to: input.nextPhase,
    });
  }
  // Allow no-op same-phase updates for idempotent retries.
  if (to === from && input.nextPhase !== current.phase) {
    return err("SCHEME_REJECTED", { message: "invalid phase transition" });
  }

  const record: PublicationJournalRecord = {
    ...current,
    phase: input.nextPhase,
    published: input.published ?? current.published,
    verified: input.verified ?? current.verified,
    files_changed: input.filesChanged
      ? [...new Set([...current.files_changed, ...input.filesChanged])].sort()
      : current.files_changed,
    updated_at: (input.now ?? new Date()).toISOString(),
  };
  const paths = resolveJournalPaths(input.vaultPath, input.operationId, home);
  try {
    atomicWriteJson(paths.journalPath, `${JSON.stringify(record, null, 2)}\n`);
  } catch (error: unknown) {
    return err("WRITE_FAILED", { message: `update journal failed: ${String(error)}` });
  }
  return ok(record);
}

export function deletePublicationJournal(
  vaultPath: string,
  operationId: string,
  home: string = process.env.HOME || homedir(),
): Result<{ deleted: boolean }> {
  const { journalPath } = resolveJournalPaths(vaultPath, operationId, home);
  if (!existsSync(journalPath)) return ok({ deleted: false });
  try {
    unlinkSync(journalPath);
    return ok({ deleted: true });
  } catch (error: unknown) {
    return err("WRITE_FAILED", { message: `delete journal failed: ${String(error)}` });
  }
}

export function completePublicationJournal(
  input: {
    vaultPath: string;
    operationId: string;
    identity: PublicationIdentitySummary;
    filesChanged?: string[];
    now?: Date;
    home?: string;
  },
): Result<{ completed: true }> {
  const advanced = advancePublicationJournal({
    ...input,
    nextPhase: "complete",
    published: true,
    verified: true,
  });
  if (!advanced.ok) return advanced;
  const deleted = deletePublicationJournal(
    input.vaultPath,
    input.operationId,
    input.home ?? process.env.HOME ?? homedir(),
  );
  if (!deleted.ok) return deleted;
  return ok({ completed: true });
}
