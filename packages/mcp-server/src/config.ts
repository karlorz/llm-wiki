import yaml from "js-yaml";
import { DEFAULT_RCLONE_COPY_TIMEOUT_MS } from "./reconcile.js";

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
    const parsed = yaml.load(fileText);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      file = parsed as FileConfig;
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
  };
}
