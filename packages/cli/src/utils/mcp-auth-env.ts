import { join } from "node:path";
import { parseDotenvFile } from "./dotenv.js";

export const MCP_URL_ENV = "SKILLWIKI_MCP_URL";
export const MCP_TOKEN_ENV = "SKILLWIKI_MCP_TOKEN";
export const MCP_HOST_ID_ENV = "SKILLWIKI_HOST_ID";

export interface McpAuthEnv {
  url?: string;
  token?: string;
  hostId?: string;
}

export function nonEmptyEnvValue(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function mcpAuthFromEnv(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
): McpAuthEnv {
  return {
    url: nonEmptyEnvValue(env[MCP_URL_ENV]),
    token: nonEmptyEnvValue(env[MCP_TOKEN_ENV]),
    hostId: nonEmptyEnvValue(env[MCP_HOST_ID_ENV]),
  };
}

/**
 * Resolve HTTP MCP auth from process env, then ~/.skillwiki/.env.
 * Non-empty process env values win. Empty keys are absent.
 */
export async function resolveMcpAuthEnv(input: {
  home: string;
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
}): Promise<McpAuthEnv> {
  const processAuth = mcpAuthFromEnv(input.env ?? process.env);
  const dotenv = await parseDotenvFile(join(input.home, ".skillwiki", ".env"));
  const fileAuth = mcpAuthFromEnv(dotenv);
  return {
    url: processAuth.url ?? fileAuth.url,
    token: processAuth.token ?? fileAuth.token,
    hostId: processAuth.hostId ?? fileAuth.hostId,
  };
}

export async function mergeMcpAuthIntoEnv(
  home: string,
  env: NodeJS.ProcessEnv,
): Promise<NodeJS.ProcessEnv> {
  const auth = await resolveMcpAuthEnv({ home, env });
  const merged: NodeJS.ProcessEnv = { ...env };
  if (auth.url && !nonEmptyEnvValue(env[MCP_URL_ENV])) merged[MCP_URL_ENV] = auth.url;
  if (auth.token && !nonEmptyEnvValue(env[MCP_TOKEN_ENV])) merged[MCP_TOKEN_ENV] = auth.token;
  if (auth.hostId && !nonEmptyEnvValue(env[MCP_HOST_ID_ENV])) merged[MCP_HOST_ID_ENV] = auth.hostId;
  return merged;
}

export function redactMcpSecret(text: string, secret: string | undefined): string {
  if (!secret || secret.length === 0 || !text.includes(secret)) return text;
  return text.split(secret).join("[REDACTED]");
}

/** MCP-only leaf: no local vault, vault-sync not installed, MCP token present. */
export function isMcpOnlyLeaf(input: {
  resolvedPath: string | undefined;
  token: string | undefined;
  vaultSyncInstalled: boolean;
}): boolean {
  return !input.resolvedPath && Boolean(input.token) && !input.vaultSyncInstalled;
}
