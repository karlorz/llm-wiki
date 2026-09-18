import { chmod, mkdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { err, ok, ExitCode, type Result } from "@skillwiki/shared";
import { parseDotenvFile, parseDotenvText, writeDotenv, type DotenvMap } from "../utils/dotenv.js";
import {
  MCP_HOST_ID_ENV,
  MCP_TOKEN_ENV,
  MCP_URL_ENV,
  mergeMcpAuthIntoEnv,
  nonEmptyEnvValue,
  redactMcpSecret,
} from "../utils/mcp-auth-env.js";
import { HOST_ID_RE } from "../utils/mcp-token-map.js";
import { DEFAULT_MCP_URL } from "../doctor/probes/mcp-handshake.js";
import { runDoctor } from "../doctor/runner.js";

export const CONNECT_DESCRIPTION =
  "HTTP MCP leaf connect: ingest a chat-attached env file into ~/.skillwiki/.env (mode 0600). Never runs skillwiki init. Cloud Drive / 云盘 is unsupported.";

export const RESERVED_HOST_IDS = ["msi", "doubao-linux-agent", "macos-dev"] as const;

const DEST_MODE = 0o600;

export interface ConnectInput {
  home: string;
  fromFile?: string;
  fromStdin?: boolean;
  dryRun?: boolean;
  force?: boolean;
  checkMcp?: boolean;
  currentVersion: string;
  env?: NodeJS.ProcessEnv;
  mcpFetch?: typeof fetch;
  readStdin?: () => Promise<string>;
}

export interface ConnectOutput {
  dest: string;
  written: boolean;
  dry_run: boolean;
  mode: "0600";
  token: "TOKEN_SET" | "EMPTY";
  auth: "present" | "not set";
  writer_id: string | null;
  ok: boolean | null;
  reconcile_ready: boolean | null;
  handshake: string | null;
  humanHint: string;
}

export function isUnsupportedSecretPath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  return /(?:^|\/)(?:Google Drive|OneDrive|iCloud Drive|CloudStorage|云盘|百度网盘|坚果云|Dropbox)(?:\/|$)/i.test(normalized)
    || /clouddrive|cloud-disk/i.test(normalized);
}

function fail(
  code: number,
  error: string,
  detail?: unknown,
): { exitCode: number; result: Result<ConnectOutput> } {
  return { exitCode: code, result: err(error, detail) };
}

async function defaultReadStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function looksLikeVaultInit(text: string): boolean {
  return /^#\s*Vault Schema/im.test(text) || /^\s*---\s*$/m.test(text) && /taxonomy:/i.test(text);
}

function tokenPresence(token: string | undefined): "TOKEN_SET" | "EMPTY" {
  return token ? "TOKEN_SET" : "EMPTY";
}

function summaryHint(data: Omit<ConnectOutput, "humanHint">): string {
  return [
    data.token,
    `auth=${data.auth}`,
    `writer_id=${data.writer_id ?? "n/a"}`,
    `ok=${data.ok ?? "n/a"}`,
    `reconcile_ready=${data.reconcile_ready ?? "n/a"}`,
    data.dry_run ? "dry-run" : (data.written ? "wrote ~/.skillwiki/.env 0600" : "not written"),
  ].join(" ");
}

function redactConnectPayload(data: ConnectOutput, secret: string | undefined): ConnectOutput {
  return {
    ...data,
    handshake: data.handshake ? redactMcpSecret(data.handshake, secret) : data.handshake,
    humanHint: redactMcpSecret(data.humanHint, secret),
  };
}

async function readWikiStatus(
  fetchFn: typeof fetch,
  url: string,
  token: string,
): Promise<{ writer_id: string | null; ok: boolean | null; reconcile_ready: boolean | null }> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  try {
    const initRes = await fetchFn(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "skillwiki-connect", version: "0" },
        },
      }),
    });
    const session = initRes.headers.get("mcp-session-id");
    if (session) headers["mcp-session-id"] = session;
    const statusRes = await fetchFn(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "wiki_status", arguments: {} },
      }),
    });
    const raw = await statusRes.text();
    const parsed = JSON.parse(raw.startsWith("data:") ? raw.replace(/^data:\s*/m, "") : raw) as {
      result?: { structuredContent?: Record<string, unknown>; content?: Array<{ text?: string }> };
    };
    const structured = parsed.result?.structuredContent;
    let body: Record<string, unknown> | undefined = structured;
    if (!body) {
      const text = parsed.result?.content?.find((c) => typeof c.text === "string")?.text;
      if (text) {
        try { body = JSON.parse(text) as Record<string, unknown>; } catch { body = undefined; }
      }
    }
    if (!body) return { writer_id: null, ok: null, reconcile_ready: null };
    return {
      writer_id: typeof body.writer_id === "string" ? body.writer_id : null,
      ok: typeof body.ok === "boolean" ? body.ok : null,
      reconcile_ready: typeof body.reconcile_ready === "boolean" ? body.reconcile_ready : null,
    };
  } catch {
    return { writer_id: null, ok: null, reconcile_ready: null };
  }
}

export async function runConnect(
  input: ConnectInput,
): Promise<{ exitCode: number; result: Result<ConnectOutput> }> {
  const dest = join(input.home, ".skillwiki", ".env");
  const fromFile = input.fromFile?.trim();
  const fromStdin = Boolean(input.fromStdin);
  if (fromFile && fromStdin) {
    return fail(ExitCode.USAGE, "USAGE", { reason: "pass --from-file or --from-stdin, not both" });
  }
  if (!fromFile && !fromStdin) {
    return fail(ExitCode.USAGE, "USAGE", {
      reason: "pass --from-file <chat-attachment> or --from-stdin (Cloud Drive / 云盘 unsupported)",
    });
  }
  if (fromFile && isUnsupportedSecretPath(fromFile)) {
    return fail(ExitCode.PREFLIGHT_FAILED, "DRIVE_UNSUPPORTED", {
      reason: "Cloud Drive / 云盘 is not a secret path. Attach the env file in chat, then skillwiki connect --from-file <attachment>.",
    });
  }

  let raw: string;
  try {
    raw = fromStdin
      ? await (input.readStdin ?? defaultReadStdin)()
      : await readFile(fromFile!, "utf8");
  } catch (e: unknown) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return fail(ExitCode.FILE_NOT_FOUND, "FILE_NOT_FOUND", { path: fromFile });
    }
    if (code === "EISDIR") {
      return fail(ExitCode.PREFLIGHT_FAILED, "NOT_ENV_FILE", { reason: "source is a directory, not an env file" });
    }
    return fail(ExitCode.PREFLIGHT_FAILED, "READ_FAILED", { reason: "could not read env source" });
  }

  if (looksLikeVaultInit(raw)) {
    return fail(ExitCode.PREFLIGHT_FAILED, "REFUSE_INIT", {
      reason: "source looks like a vault init; skillwiki connect never runs skillwiki init",
    });
  }

  const parsed = parseDotenvText(raw);
  const incomingToken = nonEmptyEnvValue(parsed[MCP_TOKEN_ENV]);
  const incomingHost = nonEmptyEnvValue(parsed[MCP_HOST_ID_ENV]);
  const incomingUrl = nonEmptyEnvValue(parsed[MCP_URL_ENV]);

  if (!incomingToken) {
    return fail(ExitCode.INVALID_CONFIG_VALUE, "TOKEN_EMPTY", {
      reason: "SKILLWIKI_MCP_TOKEN missing or empty (value not shown)",
    });
  }
  if (!incomingHost) {
    return fail(ExitCode.INVALID_CONFIG_VALUE, "HOST_ID_REQUIRED", {
      reason: "SKILLWIKI_HOST_ID missing; each machine needs a unique host-id",
    });
  }
  if (!HOST_ID_RE.test(incomingHost)) {
    return fail(ExitCode.PREFLIGHT_FAILED, "INVALID_HOST_ID", { reason: "host-id must match [a-z][a-z0-9-]{1,62}" });
  }
  if ((RESERVED_HOST_IDS as readonly string[]).includes(incomingHost) && !input.force) {
    return fail(ExitCode.PREFLIGHT_FAILED, "RESERVED_HOST_ID", {
      reason: `refuse copying reserved host-id ${incomingHost}; issue a unique id on metal or pass --force`,
    });
  }

  const existing = await parseDotenvFile(dest);
  const existingToken = nonEmptyEnvValue(existing[MCP_TOKEN_ENV]);
  if (existingToken && existingToken !== incomingToken && !input.force) {
    return fail(ExitCode.ENV_WRITE_CONFLICT, "ENV_WRITE_CONFLICT", {
      reason: "existing ~/.skillwiki/.env has a different token; pass --force to overwrite (value not shown)",
    });
  }

  const entries: DotenvMap = {
    [MCP_TOKEN_ENV]: incomingToken,
    [MCP_HOST_ID_ENV]: incomingHost,
  };
  if (incomingUrl) entries[MCP_URL_ENV] = incomingUrl;

  const dryRun = Boolean(input.dryRun);
  if (!dryRun) {
    await mkdir(join(input.home, ".skillwiki"), { recursive: true });
    let original: string | undefined;
    try { original = await readFile(dest, "utf8"); } catch { original = undefined; }
    await writeDotenv(dest, entries, original);
    await chmod(dest, DEST_MODE);
    try {
      const st = await stat(dest);
      if ((st.mode & 0o777) !== DEST_MODE) await chmod(dest, DEST_MODE);
    } catch {
      /* chmod already attempted */
    }
  }

  let writerId: string | null = null;
  let statusOk: boolean | null = null;
  let reconcileReady: boolean | null = null;
  let handshake: string | null = null;
  let doctorExit = ExitCode.OK;

  const checkMcp = input.checkMcp ?? !dryRun;
  if (checkMcp) {
    const env = await mergeMcpAuthIntoEnv(input.home, input.env ?? {});
    if (!nonEmptyEnvValue(env[MCP_TOKEN_ENV])) env[MCP_TOKEN_ENV] = incomingToken;
    if (!nonEmptyEnvValue(env[MCP_HOST_ID_ENV])) env[MCP_HOST_ID_ENV] = incomingHost;
    if (incomingUrl && !nonEmptyEnvValue(env[MCP_URL_ENV])) env[MCP_URL_ENV] = incomingUrl;
    const doctor = await runDoctor({
      home: input.home,
      envValue: undefined,
      argv: ["node", "skillwiki", "connect"],
      currentVersion: input.currentVersion,
      checkMcp: true,
      env,
      mcpFetch: input.mcpFetch,
    });
    doctorExit = doctor.exitCode;
    if (doctor.result.ok) {
      handshake = doctor.result.data.checks.find((c) => c.id === "mcp_handshake")?.detail ?? null;
    }
    const url = incomingUrl ?? DEFAULT_MCP_URL;
    const status = await readWikiStatus(input.mcpFetch ?? globalThis.fetch, url, incomingToken);
    writerId = status.writer_id;
    statusOk = status.ok;
    reconcileReady = status.reconcile_ready;
  }

  const payload: ConnectOutput = {
    dest,
    written: !dryRun,
    dry_run: dryRun,
    mode: "0600",
    token: tokenPresence(incomingToken),
    auth: incomingToken ? "present" : "not set",
    writer_id: writerId,
    ok: statusOk,
    reconcile_ready: reconcileReady,
    handshake,
    humanHint: "",
  };
  payload.humanHint = summaryHint(payload);
  const safe = redactConnectPayload(payload, incomingToken);

  if (!dryRun && checkMcp && doctorExit !== ExitCode.OK && doctorExit !== ExitCode.DOCTOR_HAS_WARNINGS) {
    return { exitCode: doctorExit, result: ok(safe) };
  }
  return { exitCode: ExitCode.OK, result: ok(safe) };
}
