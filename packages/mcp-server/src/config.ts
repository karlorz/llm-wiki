import yaml from "js-yaml";
import { DEFAULT_RCLONE_COPY_TIMEOUT_MS } from "./reconcile.js";
import type { OAuthConfig, OAuthWriterMapping } from "./oauth.js";
import { readPasswordHashFile } from "./oauth-password-file.js";
import { DEFAULT_VAULT_ID } from "./vault-id.js";
import {
  buildVaultRegistry,
  singletonVaultInput,
  type VaultEntryInput,
  type VaultRegistry,
} from "./vault-registry.js";

export interface McpDaemonConfig {
  vaultDir: string;
  bind: string;
  port: number;
  tokenMapPath: string;
  auditLogPath: string;
  rcloneRemote: string;
  rcloneBucket: string;
  s3Endpoint?: string;
  s3Bucket?: string;
  s3Prefix?: string;
  s3Region: string;
  s3AccessKeyId?: string;
  s3SecretAccessKey?: string;
  reconcileIntervalMs: number;
  rcloneTimeoutMs: number;
  ssePingMs: number;
  configPath?: string;
  oauth?: OAuthConfig;
  defaultVaultId: string;
  extraVaultInputs: VaultEntryInput[];
}

interface FileConfig {
  vault_dir?: string;
  bind?: string;
  port?: number;
  token_map?: string;
  audit_log?: string;
  rclone?: { remote?: string; bucket?: string; timeout_ms?: number };
  s3?: {
    endpoint?: string;
    bucket?: string;
    prefix?: string;
    region?: string;
    access_key_id?: string;
    secret_access_key?: string;
  };
  reconcile_interval_ms?: number;
  sse_ping_ms?: number;
  oauth?: {
    enabled?: boolean;
    password_hash?: string;
    issuer?: string;
    state_dir?: string;
    writers?: OAuthWriterMapping[];
  };
  default_vault?: string;
  vaults?: Array<{
    vault_id?: string;
    default?: boolean;
    enabled?: boolean;
    label?: string;
    local_root?: string;
    rclone?: { remote?: string; path?: string; bucket?: string; timeout_ms?: number };
    s3?: {
      endpoint?: string;
      bucket?: string;
      prefix?: string;
      region?: string;
    };
    reconcile_interval_ms?: number;
    projection_authority?: string;
    snapshot_authority?: string;
  }>;
}

function asPort(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const n = Number(value);
    if (n > 0) return n;
  }
  return fallback;
}

export function loadConfig(env: NodeJS.Dict<string>, fileText?: string): McpDaemonConfig {
  let file: FileConfig = {};
  if (fileText && fileText.trim().length > 0) {
    try {
      const parsed = yaml.load(fileText);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        file = parsed as FileConfig;
      }
    } catch {
      /* malformed YAML: ignore fileText and keep env-only config */
    }
  }

  const vaultDir = env.SKILLWIKI_MCP_VAULT ?? file.vault_dir;
  const tokenMapPath = env.SKILLWIKI_MCP_TOKEN_MAP ?? file.token_map;
  const rcloneRemote = env.SKILLWIKI_MCP_RCLONE_REMOTE ?? file.rclone?.remote;
  const rcloneBucket = env.SKILLWIKI_MCP_RCLONE_BUCKET ?? file.rclone?.bucket;
  if (!vaultDir) throw new Error("SKILLWIKI_MCP_VAULT / vault_dir is required");
  if (!tokenMapPath) throw new Error("SKILLWIKI_MCP_TOKEN_MAP / token_map is required");
  if (!rcloneRemote) throw new Error("SKILLWIKI_MCP_RCLONE_REMOTE / rclone.remote is required");
  if (!rcloneBucket) throw new Error("SKILLWIKI_MCP_RCLONE_BUCKET / rclone.bucket is required");

  return {
    vaultDir,
    bind: env.SKILLWIKI_MCP_BIND ?? file.bind ?? "127.0.0.1",
    port: asPort(env.SKILLWIKI_MCP_PORT, asPort(file.port, 8801)),
    tokenMapPath,
    auditLogPath: env.SKILLWIKI_MCP_AUDIT_FILE ?? file.audit_log ?? "/var/log/skillwiki-mcp/audit.jsonl",
    rcloneRemote,
    rcloneBucket,
    s3Endpoint: env.SKILLWIKI_MCP_S3_ENDPOINT ?? file.s3?.endpoint,
    s3Bucket: env.SKILLWIKI_MCP_S3_BUCKET ?? file.s3?.bucket,
    s3Prefix: env.SKILLWIKI_MCP_S3_PREFIX ?? file.s3?.prefix,
    s3Region: env.SKILLWIKI_MCP_S3_REGION ?? file.s3?.region ?? "us-east-1",
    s3AccessKeyId: env.SKILLWIKI_MCP_S3_ACCESS_KEY ?? env.AWS_ACCESS_KEY_ID ?? file.s3?.access_key_id,
    s3SecretAccessKey: env.SKILLWIKI_MCP_S3_SECRET_KEY ?? env.AWS_SECRET_ACCESS_KEY ?? file.s3?.secret_access_key,
    reconcileIntervalMs: asPort(env.SKILLWIKI_MCP_RECONCILE_INTERVAL_MS, asPort(file.reconcile_interval_ms, 3_600_000)),
    rcloneTimeoutMs: asPort(
      env.SKILLWIKI_MCP_RCLONE_TIMEOUT_MS,
      asPort(file.rclone?.timeout_ms, DEFAULT_RCLONE_COPY_TIMEOUT_MS),
    ),
    ssePingMs: asPort(env.SKILLWIKI_MCP_SSE_PING_MS, asPort(file.sse_ping_ms, 30_000)),
    configPath: env.SKILLWIKI_MCP_CONFIG,
    oauth: parseOAuthConfig(env, file.oauth),
    defaultVaultId: env.SKILLWIKI_MCP_DEFAULT_VAULT ?? file.default_vault ?? DEFAULT_VAULT_ID,
    extraVaultInputs: parseExtraVaultInputs(env, file),
  };
}

export function configVaultRegistry(cfg: McpDaemonConfig): VaultRegistry {
  const defaultInput = singletonVaultInput({
    vaultId: cfg.defaultVaultId,
    localRoot: cfg.vaultDir,
    rcloneRemote: cfg.rcloneRemote,
    rclonePath: cfg.rcloneBucket,
    s3Endpoint: cfg.s3Endpoint,
    s3Bucket: cfg.s3Bucket,
    s3Prefix: cfg.s3Prefix,
    s3Region: cfg.s3Region,
    reconcileIntervalMs: cfg.reconcileIntervalMs,
    rcloneTimeoutMs: cfg.rcloneTimeoutMs,
  });
  const extras = cfg.extraVaultInputs.filter((entry) => entry.vaultId !== defaultInput.vaultId);
  return buildVaultRegistry([defaultInput, ...extras], {
    central: {
      localRoot: cfg.vaultDir,
      rcloneRemote: cfg.rcloneRemote,
      rclonePath: cfg.rcloneBucket,
      s3Endpoint: cfg.s3Endpoint,
      s3Bucket: cfg.s3Bucket,
      s3Prefix: cfg.s3Prefix,
    },
  });
}

function parseExtraVaultInputs(env: NodeJS.Dict<string>, file: FileConfig): VaultEntryInput[] {
  if (env.SKILLWIKI_MCP_VAULTS) {
    try {
      const parsed = JSON.parse(env.SKILLWIKI_MCP_VAULTS) as unknown;
      if (Array.isArray(parsed)) {
        return parsed.flatMap((item) => vaultEntryFromUnknown(item) ?? []);
      }
    } catch {
      /* ignore malformed env JSON */
    }
  }
  if (!file.vaults) return [];
  return file.vaults.flatMap((item) => vaultEntryFromUnknown(item) ?? []);
}

function vaultEntryFromUnknown(item: unknown): VaultEntryInput | undefined {
  if (!item || typeof item !== "object" || Array.isArray(item)) return undefined;
  const rec = item as {
    vault_id?: unknown;
    vaultId?: unknown;
    default?: unknown;
    enabled?: unknown;
    label?: unknown;
    local_root?: unknown;
    localRoot?: unknown;
    rclone?: { remote?: unknown; path?: unknown; bucket?: unknown; timeout_ms?: unknown };
    s3?: { endpoint?: unknown; bucket?: unknown; prefix?: unknown; region?: unknown };
    reconcile_interval_ms?: unknown;
    projection_authority?: unknown;
    snapshot_authority?: unknown;
  };
  const vaultId = typeof rec.vault_id === "string" ? rec.vault_id : typeof rec.vaultId === "string" ? rec.vaultId : undefined;
  const localRoot =
    typeof rec.local_root === "string" ? rec.local_root : typeof rec.localRoot === "string" ? rec.localRoot : undefined;
  const rcloneRemote = typeof rec.rclone?.remote === "string" ? rec.rclone.remote : undefined;
  const rclonePath =
    typeof rec.rclone?.path === "string"
      ? rec.rclone.path
      : typeof rec.rclone?.bucket === "string"
        ? rec.rclone.bucket
        : undefined;
  if (!vaultId || !localRoot || !rcloneRemote || !rclonePath) return undefined;
  return {
    vaultId,
    isDefault: rec.default === true,
    enabled: rec.enabled !== false,
    label: typeof rec.label === "string" ? rec.label : undefined,
    localRoot,
    rcloneRemote,
    rclonePath,
    s3Endpoint: typeof rec.s3?.endpoint === "string" ? rec.s3.endpoint : undefined,
    s3Bucket: typeof rec.s3?.bucket === "string" ? rec.s3.bucket : undefined,
    s3Prefix: typeof rec.s3?.prefix === "string" ? rec.s3.prefix : undefined,
    s3Region: typeof rec.s3?.region === "string" ? rec.s3.region : undefined,
    reconcileIntervalMs: typeof rec.reconcile_interval_ms === "number" ? rec.reconcile_interval_ms : undefined,
    rcloneTimeoutMs: typeof rec.rclone?.timeout_ms === "number" ? rec.rclone.timeout_ms : undefined,
    projectionAuthority: typeof rec.projection_authority === "string" ? rec.projection_authority : undefined,
    snapshotAuthority: typeof rec.snapshot_authority === "string" ? rec.snapshot_authority : undefined,
  };
}

function parseOAuthConfig(
  env: NodeJS.Dict<string>,
  fileOAuth?: FileConfig["oauth"],
): OAuthConfig {
  const enabledEnv = env.SKILLWIKI_MCP_OAUTH_ENABLED;
  const enabled =
    enabledEnv !== undefined
      ? enabledEnv === "true" || enabledEnv === "1"
      : Boolean(fileOAuth?.enabled);

  const issuer = env.SKILLWIKI_MCP_OAUTH_ISSUER ?? fileOAuth?.issuer;
  const stateDir = env.SKILLWIKI_MCP_OAUTH_STATE_DIR ?? fileOAuth?.state_dir;

  const fileHash = stateDir ? readPasswordHashFile(stateDir) : undefined;
  const passwordHash =
    fileHash ?? env.SKILLWIKI_MCP_OAUTH_PASSWORD_HASH ?? fileOAuth?.password_hash;

  let writers = fileOAuth?.writers;
  if (env.SKILLWIKI_MCP_OAUTH_WRITERS) {
    try {
      writers = JSON.parse(env.SKILLWIKI_MCP_OAUTH_WRITERS) as OAuthWriterMapping[];
    } catch {
      // ignore
    }
  }

  return {
    enabled,
    passwordHash,
    issuer,
    stateDir,
    writers,
  };
}
