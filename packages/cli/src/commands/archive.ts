import { rename, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { ok, err, ExitCode, type Result } from "@skillwiki/shared";
import { scanVault, readPage } from "../utils/vault.js";
import { extractFrontmatter, splitFrontmatter } from "../parsers/frontmatter.js";
import { appendLastOp } from "../utils/last-op.js";
import {
  normalizeRemoteRoot,
  buildRemoteObjectPath,
  isValidRemoteDeleteCap,
  planAndMaybePruneRemoteObjects,
  type RcloneRunner,
  type RemotePruneResult,
} from "../utils/rclone.js";
import { buildDeleteIntent, writeDeleteIntent } from "../utils/delete-intent.js";

export interface ArchiveInput {
  vault: string;
  page: string;
  cascade?: boolean;
  apply?: boolean;
  remote?: string;
  remoteDelete?: boolean;
  maxRemoteDeletes?: number;
  rcloneRunner?: RcloneRunner;
}

export interface CascadeWikilinkRef { page: string; count: number }
export interface CascadeIndexRef { line: number; text: string }
export interface CascadeSourceArrayRef {
  page: string;
  sources_before: string[];
  sources_after: string[];
}

export interface CascadePreview {
  wikilink_refs: CascadeWikilinkRef[];
  index_refs: CascadeIndexRef[];
  source_array_refs: CascadeSourceArrayRef[];
}

export interface ArchiveOutput {
  archived_from: string;
  archived_to: string;
  index_updated: boolean;
  applied?: boolean;
  cascade?: CascadePreview;
  remote?: RemotePruneResult;
  humanHint: string;
}

function countWikilinks(body: string, slug: string): number {
  // Match [[slug]], [[slug|alias]], [[slug#anchor]] — slug is the bare basename
  const escaped = slug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`\\[\\[${escaped}(?:[|#][^\\]]*)?\\]\\]`, "g");
  const m = body.match(re);
  return m ? m.length : 0;
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export async function runArchive(input: ArchiveInput): Promise<{ exitCode: number; result: Result<ArchiveOutput> }> {
  if (input.remoteDelete && !input.remote) {
    return { exitCode: ExitCode.USAGE, result: err("USAGE", { message: "--remote-delete requires --remote" }) };
  }
  if (input.remoteDelete && !isValidRemoteDeleteCap(input.maxRemoteDeletes)) {
    return { exitCode: ExitCode.USAGE, result: err("USAGE", { message: "--max-remote-deletes must be a positive integer" }) };
  }

  const scan = await scanVault(input.vault);
  if (!scan.ok) return { exitCode: ExitCode.VAULT_PATH_INVALID, result: scan };

  const lookup = (pages: { relPath: string }[]) => {
    if (input.page.includes("/")) return pages.find(p => p.relPath === input.page)?.relPath;
    return pages.find(p => p.relPath.replace(/\.md$/, "").split("/").pop() === input.page)?.relPath;
  };

  let relPath = lookup(scan.data.typedKnowledge);
  let isRaw = false;
  if (!relPath) {
    relPath = lookup(scan.data.raw);
    isRaw = relPath != null;
  }

  if (!relPath) return { exitCode: ExitCode.ARCHIVE_TARGET_NOT_FOUND, result: err("ARCHIVE_TARGET_NOT_FOUND", { page: input.page }) };

  if (relPath.startsWith("_archive/")) return { exitCode: ExitCode.ARCHIVE_ALREADY_ARCHIVED, result: err("ARCHIVE_ALREADY_ARCHIVED", { page: relPath }) };

  const slug = relPath.replace(/\.md$/, "").split("/").pop()!;
  const archivePath = join("_archive", relPath).replace(/\\/g, "/");
  const remoteRoot = normalizeRemoteRoot(input.remote);
  const remoteObjectPath = buildRemoteObjectPath(remoteRoot, relPath);

  // ----- Cascade scan (read-only) -----
  let cascade: CascadePreview | undefined;
  if (input.cascade) {
    const wikilinkRefs: CascadeWikilinkRef[] = [];
    const sourceArrayRefs: CascadeSourceArrayRef[] = [];
    for (const page of scan.data.typedKnowledge) {
      if (page.relPath === relPath) continue;
      const text = await readPage(page);
      const split = splitFrontmatter(text);
      if (!split.ok) continue;
      // Wikilinks in body
      const wl = countWikilinks(split.data.body, slug);
      if (wl > 0) wikilinkRefs.push({ page: page.relPath, count: wl });
      // sources: arrays in frontmatter
      const fm = extractFrontmatter(text);
      if (!fm.ok) continue;
      const sources = fm.data.sources;
      if (Array.isArray(sources) && sources.includes(relPath)) {
        const before = sources.filter((s): s is string => typeof s === "string");
        const after = before.filter(s => s !== relPath);
        sourceArrayRefs.push({ page: page.relPath, sources_before: before, sources_after: after });
      }
    }
    // index.md row scan (typed-knowledge only)
    const indexRefs: CascadeIndexRef[] = [];
    if (!isRaw) {
      try {
        const idx = await readFile(join(input.vault, "index.md"), "utf8");
        idx.split("\n").forEach((line, i) => {
          if (line.includes(`[[${slug}]]`)) indexRefs.push({ line: i + 1, text: line });
        });
      } catch (e: unknown) {
        if (e instanceof Error && "code" in e && e.code !== "ENOENT") throw e;
      }
    }
    cascade = { wikilink_refs: wikilinkRefs, index_refs: indexRefs, source_array_refs: sourceArrayRefs };
  }

  // ----- Dry-run gate -----
  // --cascade alone is preview-only; --apply confirms mutation.
  if (input.cascade && !input.apply) {
    const summary = `DRY-RUN — would archive ${relPath}; ${cascade!.wikilink_refs.length} wikilink ref(s), ${cascade!.index_refs.length} index ref(s), ${cascade!.source_array_refs.length} source array ref(s).`;
    return {
      exitCode: ExitCode.OK,
      result: ok({
        archived_from: relPath,
        archived_to: archivePath,
        index_updated: false,
        applied: false,
        cascade,
        ...(remoteObjectPath ? { remote: { plannedDeletes: [remoteObjectPath], deleted: [] } } : {}),
        humanHint: summary + (remoteObjectPath ? ` (remote planned ${input.remoteDelete ? "delete" : "preview"}: ${remoteObjectPath})` : ""),
      }),
    };
  }

  // ----- Apply cascade mutations (sources arrays only) -----
  if (input.cascade && input.apply && cascade) {
    for (const ref of cascade.source_array_refs) {
      const absPath = join(input.vault, ref.page);
      const text = await readFile(absPath, "utf8");
      const split = splitFrontmatter(text);
      if (!split.ok) continue;
      // Rewrite the sources: block in the frontmatter
      const before = split.data.rawFrontmatter;
      // Replace the YAML `sources:` array. Conservative regex: matches a `sources:` key followed by
      // either inline `[...]` or block-list lines (`  - ...`) until next top-level key or end.
      const newSourcesYaml = ref.sources_after.length === 0
        ? "sources: []"
        : "sources:\n" + ref.sources_after.map(s => `  - ${s}`).join("\n");
      const fmRewritten = before.replace(
        /^sources:\s*(?:\[[^\]]*\]|(?:\r?\n(?:\s*-\s.*))+)/m,
        newSourcesYaml,
      );
      if (fmRewritten === before) continue; // no change — bail safely
      if (!arraysEqual(ref.sources_after, ref.sources_before)) {
        await writeFile(absPath, `---\n${fmRewritten}\n---${split.data.body}`, "utf8");
      }
    }
  }

  // ----- Standard archive flow (always runs unless dry-run gated above) -----
  await mkdir(dirname(join(input.vault, archivePath)), { recursive: true });

  let indexUpdated = false;
  if (!isRaw) {
    const indexPath = join(input.vault, "index.md");
    try {
      const idx = await readFile(indexPath, "utf8");
      const originalLines = idx.split("\n");
      const filtered = originalLines.filter(l => !l.includes(`[[${slug}]]`));
      if (filtered.length !== originalLines.length) {
        await writeFile(indexPath, filtered.join("\n"), "utf8");
        indexUpdated = true;
      }
    } catch (e: unknown) {
      if (e instanceof Error && "code" in e && e.code !== "ENOENT") throw e;
    }
  }

  await rename(join(input.vault, relPath), join(input.vault, archivePath));

  // Tombstone the live path so snapshot cannot resurrect it from S3 even when
  // remote-delete is skipped or fails later.
  const archiveIntent = buildDeleteIntent({
    path: relPath,
    action: "archive",
    host: process.env.SKILLWIKI_HOST_ID ?? process.env.AGENT_HOST_ID ?? "unknown",
    actor: "skillwiki-cli",
    source: "cli",
  });
  const tombstonePath = await writeDeleteIntent(input.vault, archiveIntent);

  appendLastOp(input.vault, {
    operation: input.cascade ? "archive-cascade" : "archive",
    summary: `moved ${relPath} to ${archivePath}${input.cascade ? ` (cascade: ${cascade?.source_array_refs.length ?? 0} source arrays updated)` : ""}; tombstone ${tombstonePath}`,
    files: [relPath, archivePath, tombstonePath],
    timestamp: new Date().toISOString(),
  });

  let remote: RemotePruneResult | undefined;
  if (remoteObjectPath) {
    const plannedDeletes = [remoteObjectPath];
    const pruned = await planAndMaybePruneRemoteObjects(plannedDeletes, input);
    if (!pruned.ok) {
      return { exitCode: ExitCode.SYNC_PUSH_FAILED, result: pruned };
    }
    remote = pruned.data;
  }

  const applied = input.cascade ? true : undefined;
  const cascadeNote = input.cascade ? ` (cascade: ${cascade!.source_array_refs.length} src arrays updated, ${cascade!.wikilink_refs.length} wikilinks reported)` : "";
  const remoteNote = remote
    ? ` (remote ${input.remoteDelete ? `deleted ${remote.deleted.length}` : `planned ${remote.plannedDeletes.length}`})`
    : "";
  return {
    exitCode: ExitCode.OK,
    result: ok({
      archived_from: relPath,
      archived_to: archivePath,
      index_updated: indexUpdated,
      ...(applied !== undefined ? { applied } : {}),
      ...(cascade ? { cascade } : {}),
      ...(remote ? { remote } : {}),
      humanHint: `${relPath} -> ${archivePath}${indexUpdated ? " (index updated)" : ""}${cascadeNote}${remoteNote}`,
    }),
  };
}
