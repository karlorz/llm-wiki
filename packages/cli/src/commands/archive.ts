import { rename, mkdir, readFile } from "node:fs/promises";
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
import { lifecycleDestination } from "../utils/raw-operation-policy.js";
import { applyRawStructuralMove, planRawStructuralMove } from "../utils/raw-structural-transaction.js";
import { safeWritePage } from "../utils/safe-write.js";
import { operationId } from "../utils/operation-id.js";
import { rewriteRawSourceReferences } from "../utils/raw-reference-rewrite.js";
import { snapshotMaintainedPageState } from "../utils/maintained-page-state.js";

export interface ArchiveInput {
  vault: string;
  page: string;
  cascade?: boolean;
  apply?: boolean;
  approve?: string;
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
  citation_refs: CascadeWikilinkRef[];
  index_refs: CascadeIndexRef[];
  source_array_refs: CascadeSourceArrayRef[];
}

export interface ArchiveOutput {
  archived_from: string;
  archived_to: string;
  index_updated: boolean;
  applied?: boolean;
  approval_token?: string;
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
    relPath = input.page.includes("/") ? lookup(scan.data.raw) : undefined;
    isRaw = relPath != null;
  }

  if (!relPath) return { exitCode: ExitCode.ARCHIVE_TARGET_NOT_FOUND, result: err("ARCHIVE_TARGET_NOT_FOUND", { page: input.page }) };

  if (relPath.startsWith("_archive/")) return { exitCode: ExitCode.ARCHIVE_ALREADY_ARCHIVED, result: err("ARCHIVE_ALREADY_ARCHIVED", { page: relPath }) };

  const slug = relPath.replace(/\.md$/, "").split("/").pop()!;
  const rawArchive = isRaw ? lifecycleDestination(relPath, "archive") : undefined;
  if (rawArchive && !rawArchive.ok) return { exitCode: ExitCode.USAGE, result: rawArchive };
  const archivePath = isRaw ? rawArchive!.data : join("_archive", relPath).replace(/\\/g, "/");
  const remoteRoot = normalizeRemoteRoot(input.remote);
  const remoteObjectPath = buildRemoteObjectPath(remoteRoot, relPath);

  // ----- Cascade scan (read-only) -----
  let cascade: CascadePreview | undefined;
  if (input.cascade || isRaw) {
    const wikilinkRefs: CascadeWikilinkRef[] = [];
    const citationRefs: CascadeWikilinkRef[] = [];
    const sourceArrayRefs: CascadeSourceArrayRef[] = [];
    for (const page of scan.data.typedKnowledge) {
      if (page.relPath === relPath) continue;
      const text = await readPage(page);
      const split = splitFrontmatter(text);
      if (!split.ok) continue;
      // Wikilinks in body
      const wl = countWikilinks(split.data.body, slug);
      if (wl > 0) wikilinkRefs.push({ page: page.relPath, count: wl });
      const rewritten = isRaw ? rewriteRawSourceReferences(text, relPath, archivePath) : undefined;
      const citationCount = rewritten?.bodyCitationCount ?? 0;
      if (citationCount > 0) citationRefs.push({ page: page.relPath, count: citationCount });
      // sources: arrays in frontmatter
      const fm = extractFrontmatter(text);
      if (!fm.ok) continue;
      const sources = fm.data.sources;
      if (Array.isArray(sources) && (isRaw ? rewritten!.sourcesBefore.some((source, index) => source !== rewritten!.sourcesAfter[index]) : sources.includes(relPath))) {
        const before = sources.filter((s): s is string => typeof s === "string");
        const after = isRaw ? rewritten!.sourcesAfter : before.filter(s => s !== relPath);
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
    cascade = { wikilink_refs: wikilinkRefs, citation_refs: citationRefs, index_refs: indexRefs, source_array_refs: sourceArrayRefs };
  }

  let rawPlan: Awaited<ReturnType<typeof planRawStructuralMove>> | undefined;
  if (isRaw) {
    rawPlan = await planRawStructuralMove({ vault: input.vault, operation: "archive", source: relPath, destination: archivePath });
    if (!rawPlan.ok) return { exitCode: ExitCode.WRITE_FAILED, result: rawPlan };
  }
  const citationState = isRaw ? await snapshotMaintainedPageState(scan.data.allMarkdown) : [];
  const rawApprovalToken = rawPlan?.ok
    ? operationId("raw-archive-approval", [
        rawPlan.data.operation_id,
        rawPlan.data.approval_token,
        rawPlan.data.source_sha256,
        archivePath,
        ...citationState,
      ])
    : undefined;
  const rawStructuralApproval = rawPlan?.ok ? rawPlan.data.approval_token : undefined;

  // ----- Dry-run gate -----
  // --cascade alone is preview-only; --apply confirms mutation.
  if ((input.cascade || isRaw) && !input.apply) {
    const summary = `DRY-RUN — would archive ${relPath}; ${cascade!.wikilink_refs.length} wikilink ref(s), ${cascade!.index_refs.length} index ref(s), ${cascade!.source_array_refs.length} source array ref(s).`;
    return {
      exitCode: ExitCode.OK,
      result: ok({
        archived_from: relPath,
        archived_to: archivePath,
        index_updated: false,
        applied: false,
        ...(rawApprovalToken ? { approval_token: rawApprovalToken } : {}),
        cascade,
        ...(remoteObjectPath ? { remote: { plannedDeletes: [remoteObjectPath], deleted: [] } } : {}),
        humanHint: summary + (remoteObjectPath ? ` (remote planned ${input.remoteDelete ? "delete" : "preview"}: ${remoteObjectPath})` : ""),
      }),
    };
  }

  if (isRaw) {
    if (!input.approve || !rawStructuralApproval || input.approve !== rawApprovalToken) {
      return { exitCode: ExitCode.USAGE, result: err("APPROVAL_INVALID", { message: "raw archive requires the live dry-run --approve token" }) };
    }
    const moved = await applyRawStructuralMove({
      vault: input.vault,
      operation: "archive",
      source: relPath,
      destination: archivePath,
      approve: rawStructuralApproval,
      command: "skillwiki archive",
      citationChanges: [...new Set([...(cascade?.source_array_refs.map(ref => ref.page) ?? []), ...(cascade?.citation_refs.map(ref => ref.page) ?? [])])],
    });
    if (!moved.ok) return { exitCode: ExitCode.WRITE_FAILED, result: moved };
  }

  // ----- Apply cascade mutations (sources arrays only) -----
  const rewrittenCascadePages: string[] = [];
  if ((input.cascade || isRaw) && input.apply && cascade) {
    for (const ref of cascade.source_array_refs) {
      const absPath = join(input.vault, ref.page);
      const text = await readFile(absPath, "utf8");
      if (!arraysEqual(ref.sources_after, ref.sources_before)) {
        let updated: string;
        if (isRaw) {
          updated = rewriteRawSourceReferences(text, relPath, archivePath).text;
        } else {
          const split = splitFrontmatter(text);
          if (!split.ok) continue;
          const newSourcesYaml = ref.sources_after.length === 0
            ? "sources: []"
            : "sources:\n" + ref.sources_after.map(s => `  - ${s}`).join("\n");
          const fmRewritten = split.data.rawFrontmatter.replace(
            /^sources:\s*(?:\[[^\]]*\]|(?:\r?\n(?:\s*-\s.*))+)/m,
            newSourcesYaml,
          );
          if (fmRewritten === split.data.rawFrontmatter) continue;
          updated = `---\n${fmRewritten}\n---${split.data.body}`;
        }
        const write = await safeWritePage(absPath, updated);
        if (!write.ok) return { exitCode: ExitCode.WRITE_FAILED, result: write };
        rewrittenCascadePages.push(ref.page);
      }
    }
    if (isRaw) {
      for (const ref of cascade.citation_refs) {
        if (cascade.source_array_refs.some(sourceRef => sourceRef.page === ref.page)) continue;
        const absPath = join(input.vault, ref.page);
        const original = await readFile(absPath, "utf8");
        const updated = rewriteRawSourceReferences(original, relPath, archivePath).text;
        if (updated !== original) {
          const write = await safeWritePage(absPath, updated);
          if (!write.ok) return { exitCode: ExitCode.WRITE_FAILED, result: write };
          rewrittenCascadePages.push(ref.page);
        }
      }
    }
  }

  // ----- Standard archive flow (always runs unless dry-run gated above) -----
  if (!isRaw) {
    await mkdir(dirname(join(input.vault, archivePath)), { recursive: true });
    await rename(join(input.vault, relPath), join(input.vault, archivePath));
  }

  // Rebuild root index from the post-rename page tree (full-path projection).
  let indexUpdated = false;
  if (!isRaw) {
    const { renderRootIndex, writeRootIndexProjection } = await import("../utils/index-projection.js");
    const before = await readFile(join(input.vault, "index.md"), "utf8").catch(() => "");
    const fullTarget = relPath.replace(/\.md$/, "");
    const bare = fullTarget.split("/").pop() ?? fullTarget;
    const hadIndexEntry =
      before.includes(`[[${fullTarget}]]`) || before.includes(`[[${bare}]]`);
    const projection = await renderRootIndex({ vault: input.vault, currentText: before });
    if (projection.ok && projection.data.text !== before) {
      const written = await writeRootIndexProjection(input.vault, projection.data);
      // Report index_updated only when we removed a prior listing for this page.
      if (written.ok && written.data.changed && hadIndexEntry) indexUpdated = true;
    }
  }

  // Tombstone the live path so snapshot cannot resurrect it from S3 even when
  // remote-delete is skipped or fails later.
  const archiveIntent = buildDeleteIntent({
    path: relPath,
    action: "archive",
    actor: "skillwiki-cli",
    source: "cli",
  });
  const tombstonePath = await writeDeleteIntent(input.vault, archiveIntent);

  const lastOpFiles = [relPath, archivePath, tombstonePath, ...rewrittenCascadePages];
  if (indexUpdated) lastOpFiles.push("index.md");
  const uniqueLastOpFiles = [...new Set(lastOpFiles)];

  appendLastOp(input.vault, {
    operation: input.cascade ? "archive-cascade" : "archive",
    summary: `moved ${relPath} to ${archivePath}${input.cascade ? ` (cascade: ${cascade?.source_array_refs.length ?? 0} source arrays updated)` : ""}; tombstone ${tombstonePath}`,
    files: uniqueLastOpFiles,
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

  const applied = input.cascade || isRaw ? true : undefined;
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
