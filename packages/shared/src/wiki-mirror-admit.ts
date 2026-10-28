const FORBIDDEN_BASENAMES = new Set(["agents.md", "claude.md", "gemini.md"]);
const FORBIDDEN_SEGMENTS = new Set([
  ".git",
  ".skillwiki",
  ".obsidian",
  ".claude",
  ".cursor",
  ".grok",
  ".env",
  "node_modules",
]);
const ROOT_MAINTAINED = new Set(["index.md", "SCHEMA.md", "log.md"]);
const TYPED_TOP = new Set(["concepts", "entities", "comparisons", "queries", "meta"]);

export type WikiMirrorFamily = "maintained" | "raw";

export type WikiMirrorAdmit =
  | { ok: true; path: string; family: WikiMirrorFamily }
  | { ok: false; path: string; reason: string };

function hasNul(value: string): boolean {
  return value.includes("\0");
}

export function toPosixRel(path: string): string {
  return path;
}

function segmentsOk(parts: string[]): boolean {
  return parts.every((part) => part.length > 0 && part !== "." && part !== ".." && !part.includes(".."));
}

/**
 * Admit a vault-relative Markdown path for leaf mirror materialization.
 * Maintained pages may replace a known-clean local base. raw/ is create-only.
 */
export function admitWikiMirrorPath(input: string): WikiMirrorAdmit {
  const path = toPosixRel(String(input ?? ""));
  if (!path || hasNul(path) || path.includes("\\") || path.startsWith("/") || /^[a-z]:/i.test(path) || /[\u0001-\u001f\u007f]/.test(path)) {
    return { ok: false, path, reason: "PATH_DENIED" };
  }
  const parts = path.split("/");
  if (!segmentsOk(parts)) return { ok: false, path, reason: "PATH_DENIED" };
  if (parts.some((part) => part.startsWith(".") || FORBIDDEN_SEGMENTS.has(part.toLowerCase()))) {
    return { ok: false, path, reason: "PATH_DENIED" };
  }
  const base = parts[parts.length - 1] ?? "";
  if (FORBIDDEN_BASENAMES.has(base.toLowerCase())) return { ok: false, path, reason: "ROOT_INSTRUCTIONS" };
  if (/\.(env|pem|key)$/i.test(base)) {
    return { ok: false, path, reason: "CONFIG_SECRETS" };
  }
  if (!base.endsWith(".md")) return { ok: false, path, reason: "PATH_DENIED" };

  if (parts.length === 1 && ROOT_MAINTAINED.has(base)) {
    return { ok: true, path, family: "maintained" };
  }
  if (parts[0] === "raw") {
    if (parts.length < 2) return { ok: false, path, reason: "PATH_DENIED" };
    return { ok: true, path, family: "raw" };
  }
  if (parts[0] && TYPED_TOP.has(parts[0]) && parts.length >= 2) {
    return { ok: true, path, family: "maintained" };
  }
  if (parts[0] === "projects" && parts.length >= 3 && /^[a-z0-9][a-z0-9-]*$/.test(parts[1] ?? "")) {
    return { ok: true, path, family: "maintained" };
  }
  return { ok: false, path, reason: "PATH_DENIED" };
}

export function isAdmittedWikiMirrorPath(path: string): boolean {
  return admitWikiMirrorPath(path).ok;
}
