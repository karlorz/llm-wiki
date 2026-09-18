import { isAbsolute, relative, resolve, sep } from "node:path";
import { DEFAULT_VAULT_ID, isVaultId } from "./vault-id.js";

export type VaultRegistryErrorCode =
  | "DUPLICATE_VAULT_ID"
  | "DUPLICATE_DEFAULT"
  | "MISSING_DEFAULT"
  | "MALFORMED_VAULT_ID"
  | "DISABLED_DEFAULT"
  | "ROOT_TRAVERSAL"
  | "ROOT_OVERLAP"
  | "PREFIX_OVERLAP"
  | "RCLONE_S3_MISMATCH"
  | "CENTRAL_NAMESPACE_MISMATCH"
  | "CLIENT_STORAGE_CLAIM"
  | "EXTRA_S3_NAMESPACE_REQUIRED";

export class VaultRegistryError extends Error {
  readonly code: VaultRegistryErrorCode;
  constructor(code: VaultRegistryErrorCode, message: string) {
    super(message);
    this.name = "VaultRegistryError";
    this.code = code;
  }
}

export interface VaultRegistryEntry {
  vaultId: string;
  isDefault: boolean;
  enabled: boolean;
  label: string;
  localRoot: string;
  rcloneRemote: string;
  rclonePath: string;
  s3Endpoint?: string;
  s3Bucket?: string;
  s3Prefix: string;
  s3Region: string;
  reconcileIntervalMs?: number;
  rcloneTimeoutMs?: number;
  projectionAuthority?: string;
  snapshotAuthority?: string;
}

export interface VaultRegistry {
  defaultVaultId: string;
  entries: ReadonlyMap<string, VaultRegistryEntry>;
}

export interface VaultEntryInput {
  vaultId: string;
  isDefault?: boolean;
  enabled?: boolean;
  label?: string;
  localRoot: string;
  rcloneRemote: string;
  rclonePath: string;
  s3Endpoint?: string;
  s3Bucket?: string;
  s3Prefix?: string;
  s3Region?: string;
  reconcileIntervalMs?: number;
  rcloneTimeoutMs?: number;
  projectionAuthority?: string;
  snapshotAuthority?: string;
}

export interface CentralNamespace {
  localRoot: string;
  rcloneRemote: string;
  rclonePath: string;
  s3Endpoint?: string;
  s3Bucket?: string;
  s3Prefix?: string;
}

function hasNul(value: string): boolean {
  return value.includes("\0");
}

function normalizeSlashPath(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\/+|\/+$/g, "");
}

export function normalizeObjectNamespace(bucketOrPath: string, prefix?: string): string {
  const base = normalizeSlashPath(bucketOrPath);
  const extra = normalizeSlashPath(prefix ?? "");
  if (!base) return extra.toLowerCase();
  if (!extra) return base.toLowerCase();
  return `${base}/${extra}`.toLowerCase();
}

export function namespacesOverlap(a: string, b: string): boolean {
  if (!a || !b) return a === b;
  if (a === b) return true;
  return a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

export function rcloneAndS3Agree(entry: {
  rclonePath: string;
  s3Bucket?: string;
  s3Prefix?: string;
}): boolean {
  if (!entry.s3Bucket) return true;
  const rcloneNs = normalizeObjectNamespace(entry.rclonePath);
  const s3Ns = normalizeObjectNamespace(entry.s3Bucket, entry.s3Prefix);
  return rcloneNs === s3Ns;
}

function resolvedRoot(localRoot: string): string {
  if (hasNul(localRoot)) {
    throw new VaultRegistryError("ROOT_TRAVERSAL", `local_root contains NUL: ${localRoot}`);
  }
  const trimmed = localRoot.trim();
  if (!trimmed) {
    throw new VaultRegistryError("ROOT_TRAVERSAL", "local_root is empty");
  }
  if (trimmed.split(/[/\\]/).includes("..")) {
    throw new VaultRegistryError("ROOT_TRAVERSAL", `local_root traverses parent segments: ${localRoot}`);
  }
  return resolve(trimmed);
}

function rootsOverlap(a: string, b: string): boolean {
  if (a === b) return true;
  const relA = relative(a, b);
  const relB = relative(b, a);
  const escapes = (rel: string) => rel === ".." || rel.startsWith(`..${sep}`) || rel.startsWith("../") || isAbsolute(rel);
  return !escapes(relA) || !escapes(relB);
}

function rejectClientStorageClaims(entry: VaultEntryInput): void {
  const id = entry.vaultId;
  if (id.includes("/") || id.includes("\\") || id.includes(":") || id.includes("*")) {
    throw new VaultRegistryError("CLIENT_STORAGE_CLAIM", `vault_id must not encode a storage path: ${id}`);
  }
}

export function buildVaultRegistry(
  inputs: VaultEntryInput[],
  opts?: { central?: CentralNamespace },
): VaultRegistry {
  if (inputs.length === 0) {
    throw new VaultRegistryError("MISSING_DEFAULT", "vault registry requires at least the default vault");
  }

  const resolved: VaultRegistryEntry[] = [];
  const ids = new Set<string>();
  let defaultId: string | undefined;

  for (const input of inputs) {
    rejectClientStorageClaims(input);
    if (!isVaultId(input.vaultId)) {
      throw new VaultRegistryError("MALFORMED_VAULT_ID", `malformed vault_id: ${input.vaultId}`);
    }
    if (ids.has(input.vaultId)) {
      throw new VaultRegistryError("DUPLICATE_VAULT_ID", `duplicate vault_id: ${input.vaultId}`);
    }
    ids.add(input.vaultId);

    const enabled = input.enabled !== false;
    const isDefault = Boolean(input.isDefault);
    if (isDefault) {
      if (defaultId) {
        throw new VaultRegistryError("DUPLICATE_DEFAULT", `duplicate default vault: ${defaultId} and ${input.vaultId}`);
      }
      if (!enabled) {
        throw new VaultRegistryError("DISABLED_DEFAULT", "default vault cannot be disabled");
      }
      defaultId = input.vaultId;
    }

    const localRoot = resolvedRoot(input.localRoot);
    if (!isDefault) {
      const extraBucket = (input.s3Bucket ?? "").trim();
      const extraPrefix = normalizeSlashPath(input.s3Prefix ?? "");
      if (!extraBucket || !extraPrefix) {
        throw new VaultRegistryError(
          "EXTRA_S3_NAMESPACE_REQUIRED",
          `extra vault ${input.vaultId} requires explicit s3.bucket and s3.prefix so it cannot inherit the central namespace`,
        );
      }
    }
    if (!rcloneAndS3Agree(input)) {
      throw new VaultRegistryError(
        "RCLONE_S3_MISMATCH",
        `rclone path ${input.rclonePath} does not match S3 ${input.s3Bucket}/${input.s3Prefix ?? ""} for ${input.vaultId}`,
      );
    }

    resolved.push({
      vaultId: input.vaultId,
      isDefault,
      enabled,
      label: input.label ?? input.vaultId,
      localRoot,
      rcloneRemote: input.rcloneRemote,
      rclonePath: normalizeSlashPath(input.rclonePath),
      s3Endpoint: input.s3Endpoint,
      s3Bucket: input.s3Bucket,
      s3Prefix: normalizeSlashPath(input.s3Prefix ?? ""),
      s3Region: input.s3Region ?? "us-east-1",
      reconcileIntervalMs: input.reconcileIntervalMs,
      rcloneTimeoutMs: input.rcloneTimeoutMs,
      projectionAuthority: input.projectionAuthority,
      snapshotAuthority: input.snapshotAuthority,
    });
  }

  if (!defaultId) {
    throw new VaultRegistryError("MISSING_DEFAULT", "exactly one registry entry must be default");
  }

  if (opts?.central) {
    const def = resolved.find((e) => e.vaultId === defaultId)!;
    const centralRoot = resolvedRoot(opts.central.localRoot);
    const centralRclone = normalizeSlashPath(opts.central.rclonePath);
    const centralPrefix = normalizeSlashPath(opts.central.s3Prefix ?? "");
    if (
      def.localRoot !== centralRoot ||
      def.rcloneRemote !== opts.central.rcloneRemote ||
      def.rclonePath !== centralRclone ||
      (opts.central.s3Bucket && def.s3Bucket && def.s3Bucket !== opts.central.s3Bucket) ||
      (opts.central.s3Prefix !== undefined && def.s3Prefix !== centralPrefix)
    ) {
      throw new VaultRegistryError(
        "CENTRAL_NAMESPACE_MISMATCH",
        "default vault must retain the existing central local/S3 namespace",
      );
    }
  }

  for (let i = 0; i < resolved.length; i++) {
    for (let j = i + 1; j < resolved.length; j++) {
      const a = resolved[i]!;
      const b = resolved[j]!;
      if (rootsOverlap(a.localRoot, b.localRoot)) {
        throw new VaultRegistryError(
          "ROOT_OVERLAP",
          `local roots overlap: ${a.vaultId} (${a.localRoot}) and ${b.vaultId} (${b.localRoot})`,
        );
      }
      const nsA = normalizeObjectNamespace(a.s3Bucket ?? a.rclonePath, a.s3Prefix);
      const nsB = normalizeObjectNamespace(b.s3Bucket ?? b.rclonePath, b.s3Prefix);
      const sameRemote =
        a.rcloneRemote === b.rcloneRemote ||
        (Boolean(a.s3Endpoint) && a.s3Endpoint === b.s3Endpoint && a.s3Bucket === b.s3Bucket);
      if (sameRemote && namespacesOverlap(nsA, nsB)) {
        throw new VaultRegistryError(
          "PREFIX_OVERLAP",
          `object namespaces overlap: ${a.vaultId} (${nsA}) and ${b.vaultId} (${nsB})`,
        );
      }
    }
  }

  return {
    defaultVaultId: defaultId,
    entries: new Map(resolved.map((e) => [e.vaultId, e])),
  };
}

/** Direct-S3 target for one registry entry. Extras never inherit the process-global central prefix. */
export function resolveVaultS3AdapterTarget(
  entry: VaultRegistryEntry,
  fallback: { s3Bucket?: string; s3Prefix?: string; s3Endpoint?: string },
): { bucket?: string; prefix: string; endpoint?: string } | { error: string } {
  if (!entry.isDefault) {
    if (!entry.s3Bucket || !entry.s3Prefix) {
      return { error: `extra vault ${entry.vaultId} requires explicit s3.bucket and s3.prefix` };
    }
    return { bucket: entry.s3Bucket, prefix: entry.s3Prefix, endpoint: entry.s3Endpoint ?? fallback.s3Endpoint };
  }
  return {
    bucket: entry.s3Bucket ?? fallback.s3Bucket,
    prefix: entry.s3Bucket !== undefined ? entry.s3Prefix : (entry.s3Prefix || fallback.s3Prefix || ""),
    endpoint: entry.s3Endpoint ?? fallback.s3Endpoint,
  };
}

export function singletonVaultInput(opts: {
  vaultId?: string;
  localRoot: string;
  rcloneRemote: string;
  rclonePath: string;
  s3Endpoint?: string;
  s3Bucket?: string;
  s3Prefix?: string;
  s3Region?: string;
  reconcileIntervalMs?: number;
  rcloneTimeoutMs?: number;
}): VaultEntryInput {
  return {
    vaultId: opts.vaultId ?? DEFAULT_VAULT_ID,
    isDefault: true,
    enabled: true,
    label: "Central SkillWiki",
    localRoot: opts.localRoot,
    rcloneRemote: opts.rcloneRemote,
    rclonePath: opts.rclonePath,
    s3Endpoint: opts.s3Endpoint,
    s3Bucket: opts.s3Bucket,
    s3Prefix: opts.s3Prefix,
    s3Region: opts.s3Region,
    reconcileIntervalMs: opts.reconcileIntervalMs,
    rcloneTimeoutMs: opts.rcloneTimeoutMs,
  };
}
