/**
 * Target-bound publication approval tokens.
 *
 * Tokens are intentional state confirmation, not authentication:
 * - Stateless (no time-based expiry)
 * - Bind exact draft bytes (via hash), publisher kind, target, project (when
 *   applicable), NFC-normalized one-line log note, and prior target hash
 * - Do not embed raw draft bytes or credentials
 *
 * Token format: swpub1.<base64url-canonical-payload>.<sha256-hex-of-payload-segment>
 * Checksum is SHA-256 of the UTF-8 bytes of the middle base64url payload segment.
 */
import { createHash } from "node:crypto";
import { err, ok, type Result } from "@skillwiki/shared";
import { operationId } from "./operation-id.js";

export const APPROVAL_CONTRACT = "skillwiki-publication-approval-v1" as const;
export const APPROVAL_TOKEN_VERSION = "swpub1" as const;

export type PublisherKind = "page" | "project-page";

export interface ApprovalPayload {
  contract: typeof APPROVAL_CONTRACT;
  publisher: PublisherKind;
  draft_sha256: string;
  target: string;
  /** Present only for project-page publisher. Absent for page publisher. */
  project?: string;
  log_note: string;
  /** Prior target content SHA-256, or the literal "absent". */
  prior_target_sha256: string;
}

export interface ApprovalExpected {
  publisher: PublisherKind;
  draft_sha256: string;
  target: string;
  project?: string | null;
  log_note?: string;
  prior_target_sha256: string;
}

const SHA256_HEX = /^[0-9a-f]{64}$/;
const PUBLISHERS = new Set<PublisherKind>(["page", "project-page"]);

/** SHA-256 hex of UTF-8 string or Buffer. */
export function sha256Hex(bytes: string | Buffer | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** NFC-normalize a one-line log note for approval binding. */
export function normalizeLogNote(note: string | undefined): string {
  if (note === undefined) return "";
  return note.normalize("NFC").trim();
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Deterministic canonical JSON for the approval payload.
 * Field order is fixed; `project` is omitted for page publisher.
 */
export function canonicalApprovalJson(payload: ApprovalPayload): string {
  const ordered: Record<string, string> = {
    contract: payload.contract,
    publisher: payload.publisher,
    draft_sha256: payload.draft_sha256,
    target: payload.target,
  };
  if (payload.publisher === "project-page" && payload.project !== undefined) {
    ordered.project = payload.project;
  }
  ordered.log_note = payload.log_note;
  ordered.prior_target_sha256 = payload.prior_target_sha256;
  return JSON.stringify(ordered);
}

function base64UrlEncode(text: string): string {
  return Buffer.from(text, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function base64UrlDecode(segment: string): Result<string> {
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) {
    return err("APPROVAL_INVALID", { message: "payload is not base64url" });
  }
  const padded = segment + "=".repeat((4 - (segment.length % 4)) % 4);
  const b64 = padded.replace(/-/g, "+").replace(/_/g, "/");
  try {
    return ok(Buffer.from(b64, "base64").toString("utf8"));
  } catch (error: unknown) {
    return err("APPROVAL_INVALID", { message: `payload decode failed: ${String(error)}` });
  }
}

function validatePayloadShape(value: unknown): Result<ApprovalPayload> {
  if (!isPlainObject(value)) {
    return err("APPROVAL_INVALID", { message: "payload must be a JSON object" });
  }
  if (value.contract !== APPROVAL_CONTRACT) {
    return err("APPROVAL_INVALID", { message: "unknown approval contract version" });
  }
  if (typeof value.publisher !== "string" || !PUBLISHERS.has(value.publisher as PublisherKind)) {
    return err("APPROVAL_INVALID", { message: "unknown publisher kind" });
  }
  const publisher = value.publisher as PublisherKind;
  if (typeof value.draft_sha256 !== "string" || !SHA256_HEX.test(value.draft_sha256)) {
    return err("APPROVAL_INVALID", { message: "draft_sha256 must be 64 lowercase hex chars" });
  }
  if (typeof value.target !== "string" || value.target.length === 0 || value.target.length > 500) {
    return err("APPROVAL_INVALID", { message: "invalid target" });
  }
  if (typeof value.log_note !== "string" || /[\r\n]/.test(value.log_note)) {
    return err("APPROVAL_INVALID", { message: "log_note must be a single line string" });
  }
  if (Buffer.byteLength(value.log_note, "utf8") > 500) {
    return err("APPROVAL_INVALID", { message: "log_note exceeds 500 UTF-8 bytes" });
  }
  const prior = value.prior_target_sha256;
  if (typeof prior !== "string" || (prior !== "absent" && !SHA256_HEX.test(prior))) {
    return err("APPROVAL_INVALID", { message: "prior_target_sha256 must be hex or absent" });
  }

  if (publisher === "project-page") {
    if (typeof value.project !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(value.project)) {
      return err("APPROVAL_INVALID", { message: "project-page token requires a valid project slug" });
    }
    return ok({
      contract: APPROVAL_CONTRACT,
      publisher,
      draft_sha256: value.draft_sha256,
      target: value.target,
      project: value.project,
      log_note: value.log_note,
      prior_target_sha256: prior,
    });
  }

  if (value.project !== undefined && value.project !== null) {
    return err("APPROVAL_INVALID", { message: "page publisher token must omit project" });
  }
  return ok({
    contract: APPROVAL_CONTRACT,
    publisher,
    draft_sha256: value.draft_sha256,
    target: value.target,
    log_note: value.log_note,
    prior_target_sha256: prior,
  });
}

/** Build a payload from live publication state (normalizes log note). */
export function buildApprovalPayload(input: {
  publisher: PublisherKind;
  draft_sha256: string;
  target: string;
  project?: string;
  log_note?: string;
  prior_target_sha256: string;
}): Result<ApprovalPayload> {
  const base = {
    contract: APPROVAL_CONTRACT,
    publisher: input.publisher,
    draft_sha256: input.draft_sha256,
    target: input.target,
    log_note: normalizeLogNote(input.log_note),
    prior_target_sha256: input.prior_target_sha256,
    ...(input.publisher === "project-page" ? { project: input.project } : {}),
  };
  return validatePayloadShape(base);
}

/** Encode a validated payload as swpub1.<payload>.<checksum>. */
export function encodeApprovalToken(payload: ApprovalPayload): Result<string> {
  const validated = validatePayloadShape(payload);
  if (!validated.ok) return validated;
  const json = canonicalApprovalJson(validated.data);
  const middle = base64UrlEncode(json);
  // Checksum binds the base64url payload segment (UTF-8 of the middle segment).
  const checksum = sha256Hex(middle);
  return ok(`${APPROVAL_TOKEN_VERSION}.${middle}.${checksum}`);
}

/** Decode and integrity-check a token without comparing to live state. */
export function decodeApprovalToken(token: string): Result<ApprovalPayload> {
  if (typeof token !== "string" || token.length === 0) {
    return err("APPROVAL_INVALID", { message: "empty approval token" });
  }
  // Never accept tokens that embed obvious raw markdown draft bodies.
  if (token.includes("\n") || token.includes("---\n") || token.includes("```")) {
    return err("APPROVAL_INVALID", { message: "token must not contain raw draft content" });
  }
  const parts = token.split(".");
  if (parts.length !== 3) {
    return err("APPROVAL_INVALID", { message: "token must have three segments" });
  }
  const [version, middle, checksum] = parts as [string, string, string];
  if (version !== APPROVAL_TOKEN_VERSION) {
    return err("APPROVAL_INVALID", { message: "unknown token version" });
  }
  if (!SHA256_HEX.test(checksum)) {
    return err("APPROVAL_INVALID", { message: "checksum must be 64 lowercase hex chars" });
  }
  const expectedChecksum = sha256Hex(middle);
  if (expectedChecksum !== checksum) {
    return err("APPROVAL_INVALID", { message: "checksum mismatch" });
  }
  const decoded = base64UrlDecode(middle);
  if (!decoded.ok) return decoded;
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded.data);
  } catch {
    return err("APPROVAL_INVALID", { message: "payload is not valid JSON" });
  }
  const shaped = validatePayloadShape(parsed);
  if (!shaped.ok) return shaped;
  // Re-encode must match the middle segment for canonical field ordering.
  if (base64UrlEncode(canonicalApprovalJson(shaped.data)) !== middle) {
    return err("APPROVAL_INVALID", { message: "payload is not in canonical form" });
  }
  return shaped;
}

/**
 * Verify a token against the expected live publication identity.
 * Cross-publisher replay is refused via publisher kind mismatch.
 */
export function verifyApprovalToken(
  token: string,
  expected: ApprovalExpected,
): Result<ApprovalPayload> {
  const decoded = decodeApprovalToken(token);
  if (!decoded.ok) return decoded;
  const payload = decoded.data;

  if (payload.publisher !== expected.publisher) {
    return err("APPROVAL_MISMATCH", {
      field: "publisher",
      expected: expected.publisher,
      actual: payload.publisher,
    });
  }
  if (payload.draft_sha256 !== expected.draft_sha256) {
    return err("APPROVAL_MISMATCH", {
      field: "draft_sha256",
      expected: expected.draft_sha256,
      actual: payload.draft_sha256,
    });
  }
  if (payload.target !== expected.target) {
    return err("APPROVAL_MISMATCH", {
      field: "target",
      expected: expected.target,
      actual: payload.target,
    });
  }
  if (payload.prior_target_sha256 !== expected.prior_target_sha256) {
    return err("APPROVAL_MISMATCH", {
      field: "prior_target_sha256",
      expected: expected.prior_target_sha256,
      actual: payload.prior_target_sha256,
    });
  }

  const expectedNote = normalizeLogNote(expected.log_note);
  if (payload.log_note !== expectedNote) {
    return err("APPROVAL_MISMATCH", {
      field: "log_note",
      expected: expectedNote,
      actual: payload.log_note,
    });
  }

  if (expected.publisher === "project-page") {
    if (payload.project !== expected.project) {
      return err("APPROVAL_MISMATCH", {
        field: "project",
        expected: expected.project,
        actual: payload.project,
      });
    }
  } else if (payload.project !== undefined) {
    return err("APPROVAL_MISMATCH", {
      field: "project",
      expected: null,
      actual: payload.project,
    });
  }

  return ok(payload);
}

/**
 * Stable operation ID derived from the approval contract + publisher and the
 * draft/target/project/note identity. Does not bind mutable Git base OIDs.
 *
 * prior_target_sha256 is intentionally omitted so a retry after a verified page
 * write (when prior becomes the draft hash) keeps the same operation id while
 * approval tokens still bind prior state for write authorization.
 */
export function operationIdFromApproval(payload: ApprovalPayload): string {
  const namespace = `${payload.contract}:${payload.publisher}`;
  return operationId(namespace, [
    payload.draft_sha256,
    payload.target,
    payload.project ?? "",
    payload.log_note,
  ]);
}

/** Redact approval tokens from free-form strings (receipts/errors). */
export function redactApprovalTokens(text: string): string {
  return text.replace(/swpub1\.[A-Za-z0-9_-]+\.[0-9a-f]{64}/g, "swpub1.[REDACTED]");
}
