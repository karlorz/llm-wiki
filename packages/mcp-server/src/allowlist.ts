import { isAbsolute, relative, resolve, sep } from "node:path";

const CAPTURE_RE = /^raw\/transcripts\/\d{4}-\d{2}-\d{2}-(task|idea|bug|note)-[a-z0-9-]+\.md$/;
const FORBIDDEN_BASENAMES = new Set(["AGENTS.md", "CLAUDE.md"]);

export type WriteKind = "capture" | "log_append";

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
  const base = posix.split("/").pop() ?? posix;
  return FORBIDDEN_BASENAMES.has(base);
}

export function isAllowedWritePath(relPosix: string, kind: WriteKind): boolean {
  const posix = toPosixRel(relPosix).replace(/^\/+/, "");
  if (hasNul(posix) || posix.includes("..") || isForbiddenWriteName(posix)) return false;
  if (kind === "capture") return CAPTURE_RE.test(posix);
  if (kind === "log_append") return posix === "log.md";
  return false;
}
