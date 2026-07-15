import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { err, ok, type Result } from "@skillwiki/shared";

export interface LogMergeStagesInput {
  base: string;
  ours: string;
  theirs: string;
}

export interface LogMergeStagesResult {
  text: string;
  deduplicated_operation_ids: string[];
}

const ENTRY_RE = /^## \[/m;
const PUBLISH_MARKER_RE =
  /<!--\s*skillwiki-page-publish:([a-f0-9]{64})\s*-->/i;

function splitLog(text: string): { preamble: string; entries: string[] } {
  const normalized = text.replace(/\r\n/g, "\n");
  const match = ENTRY_RE.exec(normalized);
  if (!match || match.index === undefined) {
    return { preamble: normalized.replace(/\n+$/, ""), entries: [] };
  }
  const preamble = normalized.slice(0, match.index).replace(/\n+$/, "");
  const body = normalized.slice(match.index);
  const parts = body.split(/(?=^## \[)/m).filter((p) => p.length > 0);
  const entries = parts.map((p) => p.replace(/\n+$/, ""));
  return { preamble, entries };
}

function publishId(entry: string): string | undefined {
  return PUBLISH_MARKER_RE.exec(entry)?.[1]?.toLowerCase();
}

/** Unstructured logs (no `## [` entries): use git merge-file --union. */
function unionUnstructured(base: string, ours: string, theirs: string): Result<string> {
  const dir = mkdtempSync(join(tmpdir(), "log-union-"));
  try {
    const basePath = join(dir, "base");
    const oursPath = join(dir, "ours");
    const theirsPath = join(dir, "theirs");
    writeFileSync(basePath, base.endsWith("\n") || base.length === 0 ? base : `${base}\n`);
    writeFileSync(oursPath, ours.endsWith("\n") || ours.length === 0 ? ours : `${ours}\n`);
    writeFileSync(theirsPath, theirs.endsWith("\n") || theirs.length === 0 ? theirs : `${theirs}\n`);
    // merge-file --union returns 0 even with conflicts resolved; writes to stdout with -p
    const text = execFileSync("git", ["merge-file", "--union", "-p", oursPath, basePath, theirsPath], {
      encoding: "utf8",
    });
    return ok(text.endsWith("\n") ? text : `${text}\n`);
  } catch (error: unknown) {
    return err("WRITE_FAILED", { message: `unstructured log union failed: ${String(error)}` });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Structural log merge: keep preamble + ours entries, append unseen theirs
 * blocks, and dedupe page-publish markers by operation id. Unstructured logs
 * without `## [` headings fall back to git merge-file --union.
 */
export function mergeLogConflictStages(
  input: LogMergeStagesInput,
): Result<LogMergeStagesResult> {
  const ours = splitLog(input.ours);
  const theirs = splitLog(input.theirs);
  const baseSplit = splitLog(input.base);

  if (ours.entries.length === 0 && theirs.entries.length === 0) {
    const unioned = unionUnstructured(input.base, input.ours, input.theirs);
    if (!unioned.ok) return unioned;
    return ok({ text: unioned.data, deduplicated_operation_ids: [] });
  }

  // Prefer ours preamble when present; fall back to theirs/base.
  const preamble = ours.preamble || theirs.preamble || baseSplit.preamble || "# Log";

  const seenMarkers = new Set<string>();
  const seenExact = new Set<string>();
  const out: string[] = [];
  const deduped: string[] = [];

  const push = (entry: string) => {
    const marker = publishId(entry);
    if (marker) {
      if (seenMarkers.has(marker)) {
        deduped.push(marker);
        return;
      }
      seenMarkers.add(marker);
    } else if (seenExact.has(entry)) {
      return;
    } else {
      seenExact.add(entry);
    }
    out.push(entry);
  };

  for (const e of ours.entries) push(e);
  for (const e of theirs.entries) push(e);

  let text = preamble;
  if (out.length > 0) {
    text = `${preamble.replace(/\n+$/, "")}\n\n${out.join("\n\n")}`;
  }
  if (!text.endsWith("\n")) text += "\n";

  return ok({ text, deduplicated_operation_ids: deduped });
}
