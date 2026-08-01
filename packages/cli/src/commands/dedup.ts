import { ok, err, ExitCode, type Result } from "@skillwiki/shared";
import { mapWithConcurrency, readPageCached, scanVault, vaultIoConcurrency, type PageTextCache, type VaultScan } from "../utils/vault.js";
import { extractFrontmatter, splitFrontmatter } from "../parsers/frontmatter.js";
import { appendLastOp } from "../utils/last-op.js";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, posix, resolve } from "node:path";
import {
  normalizeRemoteRoot,
  planAndMaybePruneRemoteObjects,
  type RcloneRunner,
  type RemotePruneResult,
} from "../utils/rclone.js";
import { classifyRawPath, lifecycleDestination } from "../utils/raw-operation-policy.js";
import { applyRawStructuralMove, planRawStructuralMove } from "../utils/raw-structural-transaction.js";
import { operationId } from "../utils/operation-id.js";
import { safeWritePage } from "../utils/safe-write.js";
import { rewriteRawSourceReferences } from "../utils/raw-reference-rewrite.js";
import { snapshotMaintainedPageState } from "../utils/maintained-page-state.js";

export type DedupCanonicalPolicy = "scan-order" | "stable-path";

export interface DedupInput {
  vault: string;
  apply?: boolean;
  approve?: string;
  canonicalPolicy?: DedupCanonicalPolicy;
  manifestOut?: string;
  manifestIn?: string;
  remote?: string;
  remoteDelete?: boolean;
  maxRemoteDeletes?: number;
  rcloneRunner?: RcloneRunner;
  scan?: VaultScan;
  pageTextCache?: PageTextCache;
}

export interface DedupPair {
  sha256: string;
  files: string[];
}

export interface DedupManifestEntry {
  sha256: string;
  canonical: string;
  duplicates: string[];
  bodyHash: string;
}

export interface DedupManifest {
  version: 1;
  created_at: string;
  vault: string;
  entries: DedupManifestEntry[];
}

export interface UnsafeDedupGroup {
  sha256: string;
  files: string[];
  reason: "body_hash_mismatch" | "canonical_missing";
}

export interface DedupOutput {
  scanned: number;
  duplicates: DedupPair[];
  manifest?: DedupManifest;
  unsafe?: UnsafeDedupGroup[];
  remote?: RemotePruneResult;
  rewired: string[];
  removed: string[];
  relocated: Array<{ from: string; to: string }>;
  approval_token?: string;
  humanHint: string;
}

export async function runDedup(input: DedupInput): Promise<{ exitCode: number; result: Result<DedupOutput> }> {
  if (input.canonicalPolicy && input.canonicalPolicy !== "scan-order" && input.canonicalPolicy !== "stable-path") {
    return { exitCode: ExitCode.USAGE, result: err("USAGE", { message: "--canonical-policy must be stable-path or scan-order" }) };
  }
  if (input.remoteDelete && !input.remote) {
    return { exitCode: ExitCode.USAGE, result: err("USAGE", { message: "--remote-delete requires --remote" }) };
  }
  if (input.remoteDelete && !input.apply && !input.manifestIn) {
    return { exitCode: ExitCode.USAGE, result: err("USAGE", { message: "--remote-delete requires --apply or --manifest-in" }) };
  }

  const scanResult = input.scan ? ok(input.scan) : await scanVault(input.vault);
  if (!scanResult.ok) return { exitCode: ExitCode.VAULT_PATH_INVALID, result: scanResult };
  const scan = scanResult.data;

  const manifestFromFile = input.manifestIn ? readManifest(input.manifestIn) : null;
  if (manifestFromFile && !manifestFromFile.ok) {
    return { exitCode: ExitCode.INVALID_FRONTMATTER, result: manifestFromFile };
  }

  const hashMap = new Map<string, string[]>();
  let totalFiles = 0;

  const activeRaw = scan.raw.filter(raw => {
    const classified = classifyRawPath(raw.relPath);
    return classified.ok && classified.data.storage === "active" && classified.data.category !== "assets";
  });
  const rawEntries = await mapWithConcurrency(activeRaw, vaultIoConcurrency(), async (raw) => {
    const fm = extractFrontmatter(await readPageCached(raw, input.pageTextCache));
    if (!fm.ok) return null;
    const sha = typeof fm.data.sha256 === "string" ? fm.data.sha256 : null;
    if (!sha || sha.length !== 64) return null;
    return { sha, relPath: raw.relPath };
  });

  for (const entry of rawEntries) {
    if (!entry) continue;
    totalFiles++;
    const existing = hashMap.get(entry.sha);
    if (existing) existing.push(entry.relPath);
    else hashMap.set(entry.sha, [entry.relPath]);
  }

  const canonicalPolicy = input.canonicalPolicy ?? "stable-path";
  const duplicates = [...hashMap.entries()]
    .filter(([, files]) => files.length > 1)
    .map(([sha256, files]) => ({ sha256, files: orderFiles(files, canonicalPolicy) }));

  const rewired: string[] = [];
  const removed: string[] = [];
  const relocated: Array<{ from: string; to: string }> = [];
  const unsafe: UnsafeDedupGroup[] = [];
  const safeEntries = manifestFromFile?.ok
    ? manifestFromFile.data.entries
    : buildSafeEntries(input.vault, duplicates, unsafe);
  if (manifestFromFile?.ok) {
    const validatedManifest = validateManifestLocalState(input.vault, manifestFromFile.data);
    if (!validatedManifest.ok) return { exitCode: ExitCode.USAGE, result: validatedManifest };
  }

  const manifest: DedupManifest | undefined = safeEntries.length > 0
    ? {
        version: 1,
        created_at: new Date().toISOString(),
        vault: resolve(input.vault),
        entries: safeEntries,
      }
    : undefined;

  const remoteDeleteCount = safeEntries.reduce((count, entry) => count + entry.duplicates.length, 0);
  if (input.remoteDelete && (!Number.isInteger(input.maxRemoteDeletes) || (input.maxRemoteDeletes ?? 0) < remoteDeleteCount)) {
    return { exitCode: ExitCode.USAGE, result: err("USAGE", { message: `planned remote deletes ${remoteDeleteCount} exceed --max-remote-deletes ${input.maxRemoteDeletes ?? 0}` }) };
  }

  const structuralPlans: Array<{ source: string; destination: string; canonical: string; approval: string; source_sha256: string }> = [];
  for (const entry of safeEntries) {
    for (const duplicate of entry.duplicates) {
      if (!existsSync(join(input.vault, duplicate))) continue;
      const destination = dedupDestination(input.vault, duplicate);
      const plan = await planRawStructuralMove({ vault: input.vault, operation: "deduplicate", source: duplicate, destination });
      if (!plan.ok) return { exitCode: ExitCode.WRITE_FAILED, result: plan };
      structuralPlans.push({ source: duplicate, destination, canonical: entry.canonical, approval: plan.data.approval_token, source_sha256: plan.data.source_sha256 });
    }
  }
  const citationState = await snapshotMaintainedPageState(scan.allMarkdown);
  const approvalToken = structuralPlans.length > 0
    ? operationId("raw-dedup-approval", [
        ...structuralPlans.flatMap(plan => [plan.source, plan.destination, plan.source_sha256]),
        ...citationState,
      ])
    : undefined;
  if (input.apply && structuralPlans.length > 0 && input.approve !== approvalToken) {
    return { exitCode: ExitCode.USAGE, result: err("APPROVAL_INVALID", { message: "dedup apply requires the live dry-run --approve token", approval_token: approvalToken }) };
  }

  if (input.manifestOut && manifest) {
    try {
      mkdirSync(dirname(input.manifestOut), { recursive: true });
      writeFileSync(input.manifestOut, `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");
    } catch (e) {
      return { exitCode: ExitCode.WRITE_FAILED, result: err("WRITE_FAILED", { path: input.manifestOut, message: String(e) }) };
    }
  }

  if (input.apply && structuralPlans.length > 0) {
    // Build replacement map: duplicate path → canonical path (first in group)
    // relPath from scanVault includes the type prefix (e.g., "raw/articles/...")
    // Citation markers use ^[raw/...] — so the marker path is the relPath directly
    const replacements = new Map<string, string>();
    for (const plan of structuralPlans) replacements.set(plan.source, plan.canonical);

    const pendingWrites: Array<{ page: string; text: string }> = [];
    // Compute citation rewrites before mutation, then preserve duplicates and
    // record relocation history before publishing maintained-page changes.
    for (const page of scan.allMarkdown.filter(p => !p.relPath.startsWith("raw/"))) {
      const text = readFileSync(join(input.vault, page.relPath), "utf-8");
      let updated = text;
      let changed = false;
      for (const [oldPath, newPath] of replacements) {
        const rewritten = rewriteRawSourceReferences(updated, oldPath, newPath);
        updated = rewritten.text;
        changed = changed || rewritten.changed;
      }
      if (changed) {
        pendingWrites.push({ page: page.relPath, text: updated });
        rewired.push(page.relPath);
      }
    }

    // Preserve each duplicate byte-for-byte under raw/duplicates.
    for (const plan of structuralPlans) {
      const moved = await applyRawStructuralMove({
        vault: input.vault,
        operation: "deduplicate",
        source: plan.source,
        destination: plan.destination,
        approve: plan.approval,
        command: "skillwiki dedup --apply",
        citationChanges: pendingWrites.map(write => write.page),
      });
      if (!moved.ok) return { exitCode: ExitCode.WRITE_FAILED, result: moved };
      relocated.push({ from: plan.source, to: plan.destination });
    }
    for (const pending of pendingWrites) {
      const write = await safeWritePage(join(input.vault, pending.page), pending.text);
      if (!write.ok) return { exitCode: ExitCode.WRITE_FAILED, result: write };
    }
  }

  const remote = await planAndMaybePruneRemote({ ...input, remoteDelete: input.apply || input.manifestIn ? input.remoteDelete : false }, safeEntries);
  if (!remote.ok) {
    return {
      exitCode: remote.error === "SYNC_PUSH_FAILED" ? ExitCode.SYNC_PUSH_FAILED : ExitCode.USAGE,
      result: remote,
    };
  }

  if (input.apply && (rewired.length > 0 || relocated.length > 0)) {
    appendLastOp(input.vault, {
      operation: "dedup",
      summary: `rewired ${rewired.length} pages, preserved ${relocated.length} duplicates under raw/duplicates`,
      files: [...rewired, ...relocated.flatMap(move => [move.from, move.to])],
      timestamp: new Date().toISOString(),
    });
  }

  const exitCode = duplicates.length > 0
    ? (input.apply ? ExitCode.DEDUP_APPLIED : ExitCode.RAW_DEDUP_DETECTED)
    : ExitCode.OK;
  const hintLines: string[] = [`scanned: ${totalFiles} raw files`];
  if (duplicates.length > 0) {
    hintLines.push(`duplicates: ${duplicates.length}`);
    for (const d of duplicates) hintLines.push(`  ${d.sha256.slice(0, 12)}... → ${d.files.join(", ")}`);
    if (input.apply) {
      hintLines.push(`rewired: ${rewired.length} pages`);
      hintLines.push(`preserved duplicates: ${relocated.length} raw files`);
    }
    if (unsafe.length > 0) hintLines.push(`unsafe: ${unsafe.length} groups skipped`);
    if (remote.data.plannedDeletes.length > 0) {
      hintLines.push(`remote planned deletes: ${remote.data.plannedDeletes.length}`);
      if (input.remoteDelete) hintLines.push(`remote deleted: ${remote.data.deleted.length}`);
    }
  } else {
    hintLines.push("0 duplicates");
  }

  return {
    exitCode,
    result: ok({
      scanned: totalFiles,
      duplicates,
      manifest,
      unsafe,
      remote: remote.data,
      rewired,
      removed,
      relocated,
      ...(approvalToken ? { approval_token: approvalToken } : {}),
      humanHint: hintLines.join("\n"),
    }),
  };
}

function dedupDestination(vault: string, source: string): string {
  const base = lifecycleDestination(source, "deduplicate");
  if (!base.ok) throw new Error(`unsupported raw dedup path: ${source}`);
  if (!existsSync(join(vault, base.data))) return base.data;
  const contentHash = createHash("sha256").update(readFileSync(join(vault, source))).digest("hex").slice(0, 8);
  const ext = posix.extname(base.data);
  const stem = ext ? base.data.slice(0, -ext.length) : base.data;
  return `${stem}--${contentHash}${ext}`;
}

function orderFiles(files: string[], policy: DedupCanonicalPolicy): string[] {
  if (policy === "scan-order") return [...files];
  return [...files].sort(compareStableRawPath);
}

function compareStableRawPath(a: string, b: string): number {
  return rawPathScore(a) - rawPathScore(b) || a.localeCompare(b);
}

function rawPathScore(relPath: string): number {
  const base = relPath.split("/").pop() ?? relPath;
  const stem = base.replace(/\.md$/i, "");
  let score = 0;
  if (relPath.startsWith("raw/articles/obsidian-import/")) score += 100_000;
  if (/\bdup(licate)?\b/i.test(stem)) score += 10_000;
  if (/(?:-[0-9]+|-[0-9a-f]{6,}|[0-9a-f]{8})$/i.test(stem)) score += 1_000;
  score += relPath.length;
  return score;
}

function buildSafeEntries(vault: string, duplicates: DedupPair[], unsafe: UnsafeDedupGroup[]): DedupManifestEntry[] {
  const entries: DedupManifestEntry[] = [];

  for (const group of duplicates) {
    const canonical = group.files[0];
    if (!canonical) {
      unsafe.push({ sha256: group.sha256, files: group.files, reason: "canonical_missing" });
      continue;
    }

    const bodyHashes = new Map<string, string[]>();
    for (const file of group.files) {
      const bodyHash = hashRawBody(vault, file);
      const existing = bodyHashes.get(bodyHash);
      if (existing) existing.push(file);
      else bodyHashes.set(bodyHash, [file]);
    }

    if (bodyHashes.size !== 1) {
      unsafe.push({ sha256: group.sha256, files: group.files, reason: "body_hash_mismatch" });
      continue;
    }

    const [bodyHash] = bodyHashes.keys();
    entries.push({
      sha256: group.sha256,
      canonical,
      duplicates: group.files.slice(1),
      bodyHash: bodyHash!,
    });
  }

  return entries;
}

function hashRawBody(vault: string, relPath: string): string {
  const text = readFileSync(join(vault, relPath), "utf-8");
  return hashRawBodyText(text);
}

function hashRawBodyText(text: string): string {
  const split = splitFrontmatter(text);
  const body = split.ok ? split.data.body : text;
  return createHash("sha256").update(body).digest("hex");
}

function readManifest(path: string): Result<DedupManifest> {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as DedupManifest;
    if (parsed.version !== 1 || !Array.isArray(parsed.entries)) {
      return err("INVALID_FRONTMATTER", { message: "dedup manifest must have version 1 and entries[]" });
    }
    return ok(parsed);
  } catch (e) {
    return err("INVALID_FRONTMATTER", { path, message: String(e) });
  }
}

function validateManifestLocalState(vault: string, manifest: DedupManifest): Result<true> {
  if (resolve(manifest.vault) !== resolve(vault)) {
    return err("APPROVAL_INVALID", {
      message: "dedup manifest belongs to a different vault",
      manifest_vault: manifest.vault,
      vault: resolve(vault),
    });
  }
  for (const entry of manifest.entries) {
    if (!/^[a-f0-9]{64}$/i.test(entry.sha256) || !/^[a-f0-9]{64}$/i.test(entry.bodyHash)) {
      return err("APPROVAL_INVALID", { message: "dedup manifest contains an invalid hash", canonical: entry.canonical });
    }
    const paths = [entry.canonical, ...entry.duplicates];
    if (new Set(paths).size !== paths.length) {
      return err("APPROVAL_INVALID", { message: "dedup manifest contains repeated or self-duplicate paths", canonical: entry.canonical });
    }
    for (const path of paths) {
      const classified = typeof path === "string" ? classifyRawPath(path) : err("RAW_PATH_INVALID", { path });
      if (!classified.ok || classified.data.path !== path || classified.data.storage !== "active" || classified.data.category === "assets") {
        return err("APPROVAL_INVALID", { message: "dedup manifest contains an invalid active raw source path", path });
      }
    }
    const canonicalExists = existsSync(join(vault, entry.canonical));
    const liveDuplicates = entry.duplicates.filter(path => existsSync(join(vault, path)));
    if (!canonicalExists && liveDuplicates.length > 0) {
      return err("APPROVAL_INVALID", { message: "dedup manifest canonical is missing while a local duplicate exists", canonical: entry.canonical });
    }
    for (const path of canonicalExists ? [entry.canonical, ...liveDuplicates] : liveDuplicates) {
      const text = readFileSync(join(vault, path), "utf8");
      const fm = extractFrontmatter(text);
      const declaredSha = fm.ok && typeof fm.data.sha256 === "string" ? fm.data.sha256 : null;
      if (declaredSha !== entry.sha256 || hashRawBodyText(text) !== entry.bodyHash) {
        return err("APPROVAL_INVALID", { message: "dedup manifest does not match live local raw state", path });
      }
    }
  }
  return ok(true);
}

async function planAndMaybePruneRemote(input: DedupInput, entries: DedupManifestEntry[]): Promise<Result<RemotePruneResult>> {
  const remoteRoot = normalizeRemoteRoot(input.remote);
  const plannedDeletes = remoteRoot
    ? entries.flatMap(entry => entry.duplicates.map(path => `${remoteRoot}/${path}`))
    : [];
  return planAndMaybePruneRemoteObjects(plannedDeletes, { ...input, defaultMaxDeletes: 50 });
}
