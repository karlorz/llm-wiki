import { existsSync } from "node:fs";
import { join } from "node:path";
import type { CheckResult, DoctorContext, DoctorProbe } from "../types.js";
import { check } from "./helpers.js";
import { mcpAuthFromEnv, redactMcpSecret } from "../../utils/mcp-auth-env.js";
import { withMcpClient } from "../../utils/mcp-client.js";

export const DEFAULT_MCP_URL = "https://wiki.karldigi.dev/mcp";

function mcpEnv(ctx: DoctorContext): NodeJS.ProcessEnv {
  return ctx.input.env ?? process.env;
}

function checkMcpUrl(ctx: DoctorContext): CheckResult {
  const creds = mcpAuthFromEnv(mcpEnv(ctx));
  if (creds.url) {
    return check("pass", "mcp_url_configured", "HTTP MCP URL", "configured via env override");
  }
  return check(
    "pass",
    "mcp_url_configured",
    "HTTP MCP URL",
    `plugin default ${DEFAULT_MCP_URL}`,
  );
}

function checkMcpCredential(ctx: DoctorContext): CheckResult {
  const creds = mcpAuthFromEnv(mcpEnv(ctx));
  if (creds.token) {
    return check("pass", "mcp_credential_present", "HTTP MCP auth", "present");
  }
  return check(
    "warn",
    "mcp_credential_present",
    "HTTP MCP auth",
    "not set — set in process env, ~/.skillwiki/.env, or host Configure (value not shown)",
  );
}

function checkFrozenLeafWritePath(ctx: DoctorContext): CheckResult {
  const vault = ctx.resolvedPath;
  if (!vault || !existsSync(join(vault, ".WIKI_GIT_FROZEN"))) {
    return check(
      "pass",
      "mcp_frozen_leaf_write_path",
      "HTTP MCP write path",
      "not a frozen leaf",
    );
  }
  return check(
    "pass",
    "mcp_frozen_leaf_write_path",
    "HTTP MCP write path",
    "frozen leaf — writes must use HTTP MCP, not vault git or raw/transcripts/",
  );
}

const HANDSHAKE_ID = "mcp_handshake";
const HANDSHAKE_LABEL = "HTTP MCP handshake";
const WORKITEM_TOOL = "wiki_workitem_write";

function parseCoreSemver(version: string): { major: number; minor: number; patch: number } | null {
  const m = version.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return { major: Number.parseInt(m[1], 10), minor: Number.parseInt(m[2], 10), patch: Number.parseInt(m[3], 10) };
}

function versionLessThan(a: string, b: string): boolean {
  const pa = parseCoreSemver(a);
  const pb = parseCoreSemver(b);
  if (!pa || !pb) return false;
  if (pa.major !== pb.major) return pa.major < pb.major;
  if (pa.minor !== pb.minor) return pa.minor < pb.minor;
  return pa.patch < pb.patch;
}

function redactSecret(detail: string, secret: string | undefined): string {
  return redactMcpSecret(detail, secret);
}

function handshakeRow(status: CheckResult["status"], detail: string, secret?: string): CheckResult {
  return check(status, HANDSHAKE_ID, HANDSHAKE_LABEL, redactSecret(detail, secret));
}

async function checkMcpHandshake(ctx: DoctorContext): Promise<CheckResult> {
  if (!ctx.input.checkMcp) {
    return handshakeRow("pass", "not requested — check skipped");
  }

  const env = mcpEnv(ctx);
  const creds = mcpAuthFromEnv(env);
  const url = creds.url ?? DEFAULT_MCP_URL;
  const token = creds.token ?? "";
  if (token.length === 0) {
    return handshakeRow("error", "auth not set — handshake not attempted (value not shown)");
  }

  const fetchFn = ctx.input.mcpFetch ?? globalThis.fetch;
  const shipped = ctx.input.currentVersion;
  try {
    const { advertised, tools } = await withMcpClient(
      { fetchFn, url, token, clientName: "skillwiki-doctor", version: shipped },
      async (client, signal) => ({
        advertised: client.getServerVersion()?.version ?? "",
        tools: (await client.listTools({}, { signal })).tools.map((tool) => tool.name),
      }),
    );
    if (!advertised) {
      return handshakeRow("error", "handshake failed — missing serverInfo.version", token);
    }

    const frozen = Boolean(ctx.resolvedPath && existsSync(join(ctx.resolvedPath, ".WIKI_GIT_FROZEN")));
    if (frozen && !tools.includes(WORKITEM_TOOL)) {
      return handshakeRow(
        "error",
        `captures-only tool list (${tools.length} tools, missing ${WORKITEM_TOOL}) on frozen leaf — advertised ${advertised}`,
        token,
      );
    }
    if (versionLessThan(advertised, shipped)) {
      return handshakeRow(
        "warn",
        `advertised ${advertised} lags shipped ${shipped} (${tools.length} tools)`,
        token,
      );
    }
    return handshakeRow("pass", `advertised ${advertised}, ${tools.length} tools`, token);
  } catch (e: unknown) {
    const raw = e instanceof Error ? e.message : String(e);
    const safe = redactSecret(raw, token);
    return handshakeRow("error", `handshake failed — ${safe}`, token);
  }
}

export const mcpHandshakeProbe: DoctorProbe = {
  id: "mcp",
  label: "HTTP MCP",
  async run(ctx: DoctorContext): Promise<CheckResult[]> {
    return [
      checkMcpUrl(ctx),
      checkMcpCredential(ctx),
      checkFrozenLeafWritePath(ctx),
      await checkMcpHandshake(ctx),
    ];
  },
};
