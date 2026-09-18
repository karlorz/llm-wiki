import { existsSync } from "node:fs";
import { join } from "node:path";
import type { CheckResult, DoctorContext, DoctorProbe } from "../types.js";
import { check } from "./helpers.js";
import { mcpAuthFromEnv, redactMcpSecret } from "../../utils/mcp-auth-env.js";

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

function parseMcpBody(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return JSON.parse(trimmed);
  }
  for (const line of trimmed.split(/\r?\n/)) {
    const prefix = line.startsWith("data:") ? line.slice(5).trim() : "";
    if (prefix.startsWith("{")) return JSON.parse(prefix);
  }
  throw new Error("non-JSON MCP body");
}

function jsonRpcResult(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null) {
    throw new Error("invalid JSON-RPC body");
  }
  const rec = body as { error?: { message?: string }; result?: unknown };
  if (rec.error) {
    throw new Error(typeof rec.error.message === "string" ? rec.error.message : "JSON-RPC error");
  }
  if (typeof rec.result !== "object" || rec.result === null) {
    throw new Error("missing JSON-RPC result");
  }
  return rec.result as Record<string, unknown>;
}

async function mcpJsonRpc(
  fetchFn: typeof fetch,
  url: string,
  token: string,
  method: string,
  id: number,
  params: Record<string, unknown>,
  sessionId?: string,
): Promise<{ result: Record<string, unknown>; sessionId?: string }> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (sessionId) headers["mcp-session-id"] = sessionId;
  const res = await fetchFn(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  const nextSession = res.headers.get("mcp-session-id") ?? sessionId;
  const result = jsonRpcResult(parseMcpBody(await res.text()));
  return { result, sessionId: nextSession ?? undefined };
}

function toolNames(result: Record<string, unknown>): string[] {
  const tools = result.tools;
  if (!Array.isArray(tools)) return [];
  return tools
    .map((t) => (typeof t === "object" && t !== null && typeof (t as { name?: unknown }).name === "string"
      ? (t as { name: string }).name
      : ""))
    .filter((name) => name.length > 0);
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
    const init = await mcpJsonRpc(
      fetchFn,
      url,
      token,
      "initialize",
      1,
      {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "skillwiki-doctor", version: shipped },
      },
    );
    const serverInfo = init.result.serverInfo;
    const advertised = (typeof serverInfo === "object" && serverInfo !== null
      && typeof (serverInfo as { version?: unknown }).version === "string")
      ? (serverInfo as { version: string }).version
      : "";
    if (!advertised) {
      return handshakeRow("error", "handshake failed — missing serverInfo.version", token);
    }

    const listed = await mcpJsonRpc(
      fetchFn,
      url,
      token,
      "tools/list",
      2,
      {},
      init.sessionId,
    );
    const tools = toolNames(listed.result);
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
