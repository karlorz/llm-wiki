import { realpathSync, statSync, existsSync, accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import {
  CLIP_OUTBOX_DEFAULTS,
  isClipOutboxKey,
  parseClipOutboxKeyValue,
} from "@skillwiki/shared";
import { parseDotenvFile } from "./dotenv.js";
import { resolveSkillwikiHome } from "./home.js";

export const CLIP_NOT_CONFIGURED = "clip channel not configured";
export const PRODUCTION_WATCHER_LABEL = CLIP_OUTBOX_DEFAULTS.watcher_label;
export const PRODUCTION_MIRROR_LABEL = "com.karlchow.skillwiki-mirror-sse";
export const RETIRED_WATCHER_LABELS = [
  "com.karlchow.wiki-dev-outbox",
  "com.karlchow.wiki-dev-sse",
  "com.karlchow.wiki-dev-hourly",
  "com.karlchow.skillwiki-note-outbox",
] as const;

export interface ResolvedClipOutboxConfig {
  enabled: boolean;
  root: string;
  stateRoot: string;
  mirrorRoot: string;
  d8NoteRoot: string | null;
  d8NoteAbsent: boolean;
  vaultId: "central";
  allowedPrefixes: readonly ["raw/articles", "raw/assets"];
  destination: "seaweed-wiki:cloud/wiki";
  mode: "event-watch";
  pollFallbackEnabled: boolean;
  reconcileSeconds: number;
  debounceMs: number;
  stableHashMs: number;
  maxArticleBytes: number;
  maxImages: number;
  maxImageBytes: number;
  maxBundleBytes: number;
  maxPixels: number;
  downloadConcurrency: number;
  imageTypes: readonly string[];
  maxRedirects: number;
  requestTimeoutMs: number;
  localizeTimeoutMs: number;
  readyUrl: string;
  s3CredentialRef: string;
  readyCredentialRef: string;
  watcherLabel: typeof PRODUCTION_WATCHER_LABEL;
}

export type ClipConfigResult =
  | { ok: true; enabled: false }
  | { ok: true; enabled: true; config: ResolvedClipOutboxConfig }
  | { ok: false; message: string };

export function expandUserPath(raw: string, home: string): string {
  if (raw === "~") return home;
  if (raw.startsWith("~/")) return resolve(home, raw.slice(2));
  return raw;
}

function canonicalPath(raw: string, home: string): { ok: true; path: string } | { ok: false; message: string } {
  const expanded = expandUserPath(raw.trim(), home);
  if (expanded.includes("\0")) return { ok: false, message: "path contains NUL" };
  if (expanded.includes("://") || expanded.includes("@")) {
    return { ok: false, message: "path must not include URL credentials" };
  }
  if (!isAbsolute(expanded)) return { ok: false, message: "must be an absolute path" };
  try {
    const real = existsSync(expanded) ? realpathSync(expanded) : resolve(expanded);
    if (real.split(sep).some((seg) => seg === "..")) {
      return { ok: false, message: "path must not contain traversal" };
    }
    return { ok: true, path: real };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "invalid path" };
  }
}

export function nestedOrEqual(a: string, b: string): boolean {
  if (a === b) return true;
  const prefixA = a.endsWith(sep) ? a : a + sep;
  const prefixB = b.endsWith(sep) ? b : b + sep;
  return prefixA.startsWith(prefixB) || prefixB.startsWith(prefixA);
}

function intField(value: string | undefined, fallback: string): number {
  return Number(value && value.length > 0 ? value : fallback);
}

function requireWritableDir(path: string, label: string): string | undefined {
  try {
    const st = statSync(path);
    if (!st.isDirectory()) return `${label} is not a directory`;
    accessSync(path, constants.W_OK);
    return undefined;
  } catch {
    return `${label} is missing or not writable`;
  }
}

export function resolveClipOutboxConfig(map: Record<string, string>, home: string): ClipConfigResult {
  const present = Object.keys(map).filter(isClipOutboxKey);
  for (const key of present) {
    const parsed = parseClipOutboxKeyValue(key, map[key] ?? "");
    if (!parsed.ok) return { ok: false, message: `${key}: ${parsed.message}` };
  }

  const enabled = (map["clip_outbox.enabled"] ?? CLIP_OUTBOX_DEFAULTS.enabled) === "true";
  if (!enabled) {
    return { ok: true, enabled: false };
  }

  const required = [
    "clip_outbox.root",
    "clip_outbox.state_root",
    "clip_outbox.mirror_root",
    "clip_outbox.ready_url",
    "clip_outbox.s3_credential_ref",
    "clip_outbox.ready_credential_ref",
  ] as const;
  for (const key of required) {
    if (!map[key]) return { ok: false, message: `${key} is required when clip_outbox.enabled=true` };
  }

  const d8Absent = map["clip_outbox.d8_note_absent"] === "true";
  const d8RootRaw = map["clip_outbox.d8_note_root"];
  if (d8Absent && d8RootRaw) {
    return { ok: false, message: "clip_outbox.d8_note_root and clip_outbox.d8_note_absent cannot both be set" };
  }
  if (!d8Absent && !d8RootRaw) {
    return { ok: false, message: "clip_outbox.d8_note_root or clip_outbox.d8_note_absent=true is required when enabled" };
  }

  const root = canonicalPath(map["clip_outbox.root"]!, home);
  const stateRoot = canonicalPath(map["clip_outbox.state_root"]!, home);
  const mirrorRoot = canonicalPath(map["clip_outbox.mirror_root"]!, home);
  if (!root.ok) return { ok: false, message: `clip_outbox.root: ${root.message}` };
  if (!stateRoot.ok) return { ok: false, message: `clip_outbox.state_root: ${stateRoot.message}` };
  if (!mirrorRoot.ok) return { ok: false, message: `clip_outbox.mirror_root: ${mirrorRoot.message}` };

  let d8NoteRoot: string | null = null;
  if (d8RootRaw) {
    const d8 = canonicalPath(d8RootRaw, home);
    if (!d8.ok) return { ok: false, message: `clip_outbox.d8_note_root: ${d8.message}` };
    d8NoteRoot = d8.path;
  }

  if (nestedOrEqual(root.path, mirrorRoot.path)) {
    return { ok: false, message: "clip_outbox.root must be outside the frozen mirror" };
  }
  if (nestedOrEqual(root.path, stateRoot.path) || nestedOrEqual(stateRoot.path, mirrorRoot.path)) {
    return { ok: false, message: "clip_outbox.state_root must be disjoint from outbox and mirror" };
  }
  if (d8NoteRoot && (nestedOrEqual(root.path, d8NoteRoot) || nestedOrEqual(stateRoot.path, d8NoteRoot))) {
    return { ok: false, message: "clip outbox must not equal or nest the D8 note outbox" };
  }

  const rootErr = requireWritableDir(root.path, "clip_outbox.root");
  if (rootErr) return { ok: false, message: rootErr };
  const stateErr = requireWritableDir(stateRoot.path, "clip_outbox.state_root");
  if (stateErr) {
    if (existsSync(stateRoot.path)) return { ok: false, message: stateErr };
    // state root may be created by the worker; require parent writable
    const parentErr = requireWritableDir(resolve(stateRoot.path, ".."), "clip_outbox.state_root parent");
    if (parentErr) return { ok: false, message: stateErr };
  }
  if (!existsSync(mirrorRoot.path)) {
    return { ok: false, message: "clip_outbox.mirror_root does not exist" };
  }

  const vaultId = map["clip_outbox.vault_id"] ?? CLIP_OUTBOX_DEFAULTS.vault_id;
  if (vaultId !== "central") return { ok: false, message: "clip_outbox.vault_id must be central" };
  const destination = map["clip_outbox.destination"] ?? CLIP_OUTBOX_DEFAULTS.destination;
  if (destination !== CLIP_OUTBOX_DEFAULTS.destination) {
    return { ok: false, message: "clip_outbox.destination must be seaweed-wiki:cloud/wiki" };
  }
  const mode = map["clip_outbox.mode"] ?? CLIP_OUTBOX_DEFAULTS.mode;
  if (mode !== "event-watch") return { ok: false, message: "clip_outbox.mode must be event-watch" };
  const watcherLabel = map["clip_outbox.watcher_label"] ?? CLIP_OUTBOX_DEFAULTS.watcher_label;
  if (watcherLabel !== PRODUCTION_WATCHER_LABEL) {
    return { ok: false, message: "clip_outbox.watcher_label must be the production clip watcher" };
  }

  const imageTypes = (map["clip_outbox.image_types"] ?? CLIP_OUTBOX_DEFAULTS.image_types)
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);

  return {
    ok: true,
    enabled: true,
    config: {
      enabled: true,
      root: root.path,
      stateRoot: stateRoot.path,
      mirrorRoot: mirrorRoot.path,
      d8NoteRoot,
      d8NoteAbsent: d8Absent,
      vaultId: "central",
      allowedPrefixes: ["raw/articles", "raw/assets"],
      destination: "seaweed-wiki:cloud/wiki",
      mode: "event-watch",
      pollFallbackEnabled: (map["clip_outbox.poll_fallback_enabled"] ?? CLIP_OUTBOX_DEFAULTS.poll_fallback_enabled) === "true",
      reconcileSeconds: intField(map["clip_outbox.reconcile_seconds"], CLIP_OUTBOX_DEFAULTS.reconcile_seconds),
      debounceMs: intField(map["clip_outbox.debounce_ms"], CLIP_OUTBOX_DEFAULTS.debounce_ms),
      stableHashMs: intField(map["clip_outbox.stable_hash_ms"], CLIP_OUTBOX_DEFAULTS.stable_hash_ms),
      maxArticleBytes: intField(map["clip_outbox.max_article_bytes"], CLIP_OUTBOX_DEFAULTS.max_article_bytes),
      maxImages: intField(map["clip_outbox.max_images"], CLIP_OUTBOX_DEFAULTS.max_images),
      maxImageBytes: intField(map["clip_outbox.max_image_bytes"], CLIP_OUTBOX_DEFAULTS.max_image_bytes),
      maxBundleBytes: intField(map["clip_outbox.max_bundle_bytes"], CLIP_OUTBOX_DEFAULTS.max_bundle_bytes),
      maxPixels: intField(map["clip_outbox.max_pixels"], CLIP_OUTBOX_DEFAULTS.max_pixels),
      downloadConcurrency: intField(map["clip_outbox.download_concurrency"], CLIP_OUTBOX_DEFAULTS.download_concurrency),
      imageTypes,
      maxRedirects: intField(map["clip_outbox.max_redirects"], CLIP_OUTBOX_DEFAULTS.max_redirects),
      requestTimeoutMs: intField(map["clip_outbox.request_timeout_ms"], CLIP_OUTBOX_DEFAULTS.request_timeout_ms),
      localizeTimeoutMs: intField(map["clip_outbox.localize_timeout_ms"], CLIP_OUTBOX_DEFAULTS.localize_timeout_ms),
      readyUrl: map["clip_outbox.ready_url"]!,
      s3CredentialRef: map["clip_outbox.s3_credential_ref"]!,
      readyCredentialRef: map["clip_outbox.ready_credential_ref"]!,
      watcherLabel: PRODUCTION_WATCHER_LABEL,
    },
  };
}

function clipOutboxConfigPath(home: string): string {
  return join(resolveSkillwikiHome(home), ".skillwiki", ".env");
}

export async function loadClipOutboxConfig(home: string): Promise<ClipConfigResult> {
  const map = await parseDotenvFile(clipOutboxConfigPath(home));
  return resolveClipOutboxConfig(map as Record<string, string>, home || homedir());
}
