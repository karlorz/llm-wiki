import { ok, err, ExitCode, type Result } from "@skillwiki/shared";
import { scanVault, readPage } from "../utils/vault.js";
import { extractFrontmatter, splitFrontmatter } from "../parsers/frontmatter.js";
import { appendLastOp } from "../utils/last-op.js";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  normalizeRemoteRoot,
  planAndMaybePruneRemoteObjects,
  type RcloneRunner,
  type RemotePruneResult,
} from "../utils/rclone.js";

export type DedupCanonicalPolicy = "scan-order" | "stable-path";

export interface DedupInput {
  vault: string;
  apply?: boolean;
  canonicalPolicy?: DedupCanonicalPolicy;
  manifestOut?: string;
  manifestIn?: string;
  remote?: string;
  remoteDelete?: boolean;
  maxRemoteDeletes?: number;
  rcloneRunner?: RcloneRunner;
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

  const scan = await scanVault(input.vault);
  if (!scan.ok) return { exitCode: ExitCode.VAULT_PATH_INVALID, result: scan };

  const manifestFromFile = input.manifestIn ? readManifest(input.manifestIn) : null;
  if (manifestFromFile && !manifestFromFile.ok) {
    return { exitCode: ExitCode.INVALID_FRONTMATTER, result: manifestFromFile };
  }

  const hashMap = new Map<string, string[]>();
  let totalFiles = 0;

  for (const raw of scan.data.raw) {
    const fm = extractFrontmatter(await readPage(raw));
    if (!fm.ok) continue;
    const sha = typeof fm.data.sha256 === "string" ? fm.data.sha256 : null;
    if (!sha || sha.length !== 64) continue;

    totalFiles++;
    const existing = hashMap.get(sha);
    if (existing) existing.push(raw.relPath);
    else hashMap.set(sha, [raw.relPath]);
  }

  const canonicalPolicy = input.canonicalPolicy ?? "stable-path";
  const duplicates = [...hashMap.entries()]
    .filter(([, files]) => files.length > 1)
    .map(([sha256, files]) => ({ sha256, files: orderFiles(files, canonicalPolicy) }));

  const rewired: string[] = [];
  const removed: string[] = [];
  const unsafe: UnsafeDedupGroup[] = [];
  const safeEntries = manifestFromFile?.ok
    ? manifestFromFile.data.entries
    : buildSafeEntries(input.vault, duplicates, unsafe);

  const manifest: DedupManifest | undefined = safeEntries.length > 0
    ? {
        version: 1,
        created_at: new Date().toISOString(),
        vault: resolve(input.vault),
        entries: safeEntries,
      }
    : undefined;

  const remote = await planAndMaybePruneRemote(input, safeEntries);
  if (!remote.ok) {
    return {
      exitCode: remote.error === "SYNC_PUSH_FAILED" ? ExitCode.SYNC_PUSH_FAILED : ExitCode.USAGE,
      result: remote,
    };
  }

  if (input.manifestOut && manifest) {
    try {
      mkdirSync(dirname(input.manifestOut), { recursive: true });
      writeFileSync(input.manifestOut, `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");
    } catch (e) {
      return { exitCode: ExitCode.WRITE_FAILED, result: err("WRITE_FAILED", { path: input.manifestOut, message: String(e) }) };
    }
  }

  if (input.apply && safeEntries.length > 0) {
    // Build replacement map: duplicate path → canonical path (first in group)
    // relPath from scanVault includes the type prefix (e.g., "raw/articles/...")
    // Citation markers use ^[raw/...] — so the marker path is the relPath directly
    const replacements = new Map<string, string>();
    for (const entry of safeEntries) {
      for (const duplicate of entry.duplicates) {
        replacements.set(duplicate, entry.canonical);
      }
    }

    // Rewire citations in all non-raw markdown pages. Raw files stay immutable.
    for (const page of scan.data.allMarkdown.filter(p => !p.relPath.startsWith("raw/"))) {
      const text = readFileSync(join(input.vault, page.relPath), "utf-8");
      let updated = text;
      let changed = false;
      for (const [oldPath, newPath] of replacements) {
        const oldMarker = `^[${oldPath}]`;
        const newMarker = `^[${newPath}]`;
        if (updated.includes(oldMarker)) {
          updated = updated.replaceAll(oldMarker, newMarker);
          changed = true;
        }
        // Also rewrite in frontmatter sources list
        const oldFm = `- "^[${oldPath}]"`;
        const newFm = `- "^[${newPath}]"`;
        if (updated.includes(oldFm)) {
          updated = updated.replaceAll(oldFm, newFm);
          changed = true;
        }
      }
      if (changed) {
        writeFileSync(join(input.vault, page.relPath), updated);
        rewired.push(page.relPath);
      }
    }

    // Delete duplicate raw files
    for (const oldPath of replacements.keys()) {
      const fullPath = join(input.vault, oldPath);
      try {
        unlinkSync(fullPath);
        removed.push(oldPath);
      } catch {
        // File may already be gone; skip
      }
    }
  }

  if (input.apply && (rewired.length > 0 || removed.length > 0)) {
    appendLastOp(input.vault, {
      operation: "dedup",
      summary: `rewired ${rewired.length} pages, removed ${removed.length} duplicates`,
      files: [...rewired, ...removed],
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
      hintLines.push(`removed: ${removed.length} raw files`);
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
      humanHint: hintLines.join("\n"),
    }),
  };
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

async function planAndMaybePruneRemote(input: DedupInput, entries: DedupManifestEntry[]): Promise<Result<RemotePruneResult>> {
  const remoteRoot = normalizeRemoteRoot(input.remote);
  const plannedDeletes = remoteRoot
    ? entries.flatMap(entry => entry.duplicates.map(path => `${remoteRoot}/${path}`))
    : [];
  return planAndMaybePruneRemoteObjects(plannedDeletes, { ...input, defaultMaxDeletes: 50 });
}
