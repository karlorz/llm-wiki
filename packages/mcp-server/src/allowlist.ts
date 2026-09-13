import { isAbsolute, relative, resolve, sep } from "node:path";

const CAPTURE_RE = /^raw\/transcripts\/\d{4}-\d{2}-\d{2}-(task|idea|bug|note)-[a-z0-9-]+\.md$/;
const FORBIDDEN_BASENAMES = new Set(["AGENTS.md", "CLAUDE.md"]);

export type WriteKind = "capture" | "log_append" | "workitem" | "page_publish";

const WORKITEM_FILE_RE =
  /^projects\/[a-z0-9][a-z0-9-]*\/work\/\d{4}-\d{2}-\d{2}-[a-z0-9-]+\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.md$/;
const WORKITEM_KNOWLEDGE_RE = /^projects\/[a-z0-9][a-z0-9-]*\/knowledge\.md$/;
const PAGE_PUBLISH_RE =
  /^(entities|concepts|comparisons|queries|meta)\/[a-z0-9][a-z0-9._/-]*\.md$/;

function hasNul(value: string): boolean {
  return value.includes("\0");
}

export function toPosixRel(rel: string): string {
  return rel.split("\\").join("/");
}

export function resolveWithinVault(vaultRoot: string, relOrAbs: string): string | null {
  if (hasNul(relOrAbs) || hasNul(vaultRoot)) return null;
  const root = resolve(vaultRoot);
  const candidate = isAbsolute(relOrAbs) ? resolve(relOrAbs) : resolve(root, relOrAbs);
  const rel = relative(root, candidate);
  if (rel === "") return candidate;
  if (rel.startsWith(`..${sep}`) || rel === ".." || rel.startsWith("../") || isAbsolute(rel)) {
    return null;
  }
  return candidate;
}

export function isForbiddenWriteName(relPosix: string): boolean {
  const posix = toPosixRel(relPosix);
  const segments = posix.split("/");
  return segments.some((seg) => FORBIDDEN_BASENAMES.has(seg));
}

export function isAllowedWritePath(relPosix: string, kind: WriteKind): boolean {
  const posix = toPosixRel(relPosix).replace(/^\/+/, "");
  const segments = posix.split("/");
  if (
    hasNul(posix) ||
    posix.includes("..") ||
    segments.some((seg) => seg === "" || seg === "." || seg === "..") ||
    isForbiddenWriteName(posix)
  ) {
    return false;
  }
  if (kind === "capture") return CAPTURE_RE.test(posix);
  if (kind === "log_append") return posix === "log.md";
  if (kind === "workitem") return WORKITEM_FILE_RE.test(posix) || WORKITEM_KNOWLEDGE_RE.test(posix);
  if (kind === "page_publish") return PAGE_PUBLISH_RE.test(posix);
  return false;
}
