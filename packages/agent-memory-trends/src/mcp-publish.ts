import { readFileSync } from "node:fs";
import { join } from "node:path";
import { load as loadYaml } from "js-yaml";
import { parseRunManifest } from "./allowlist.js";
import { err, ok, type Result } from "./types.js";

export type McpPublicationAction =
  | { tool: "wiki_page_publish"; path: string; content: string }
  | { tool: "wiki_capture"; path: string; kind: "task" | "idea" | "bug" | "note"; project: string; title: string; content: string };

export interface PlanMcpPublicationInput {
  vault: string;
  runDate: string;
  manifestPath: string;
  project: string;
  readFile?: (path: string) => string;
}

export interface McpPublicationPlan {
  actions: McpPublicationAction[];
  hostLocalPaths: string[];
  quietRun: boolean;
}

export interface McpToolSuccess {
  ok: true;
  [key: string]: unknown;
}

export interface McpToolFailure {
  ok: false;
  error: string;
  message?: string;
  currentVersion?: string;
  path?: string;
}

export type McpToolResult = McpToolSuccess | McpToolFailure;
export type McpToolCaller = (name: string, args: Record<string, unknown>) => Promise<McpToolResult>;

export interface PublishGeneratedOutputsToMcpInput extends PlanMcpPublicationInput {
  callTool: McpToolCaller;
  expectedWriterId?: string;
}

export interface PublishGeneratedOutputsToMcpOutput {
  publishedPaths: string[];
  hostLocalPaths: string[];
  writerId: string;
  quietRun: boolean;
}

export interface PublishSinglePageToMcpOutput {
  path: string;
  writerId: string;
}

export interface PublishSinglePageToMcpInput {
  callTool: McpToolCaller;
  path: string;
  content: string;
  expectedWriterId?: string;
}

const DIGEST_RE = /^queries\/\d{4}-\d{2}-\d{2}-agent-memory-trends-digest\.md$/;
export const PACKET_RE = /^queries\/\d{4}-\d{2}-\d{2}-agent-memory-trends-packet\.md$/;
const CAPTURE_RE = /^raw\/transcripts\/\d{4}-\d{2}-\d{2}-(task|idea|bug|note)-[a-z0-9-]+\.md$/;
const SESSION_BRIEF_PATH = "meta/latest-session-brief.md";

export function planMcpPublication(input: PlanMcpPublicationInput): Result<McpPublicationPlan> {
  const read = input.readFile ?? ((path: string) => readFileSync(path, "utf8"));
  let manifestText: string;
  try {
    manifestText = read(join(input.vault, input.manifestPath));
  } catch (error) {
    return err("MANIFEST_READ_FAILED", error instanceof Error ? error.message : String(error));
  }

  const parsed = parseRunManifest(manifestText);
  if (!parsed.ok) return parsed;
  if (parsed.data.runDate !== input.runDate) {
    return err("MANIFEST_INVALID", `run manifest date ${parsed.data.runDate} does not match ${input.runDate}`);
  }
  if (parsed.data.status && parsed.data.status !== "success") {
    return err("MANIFEST_INVALID", `run manifest status ${parsed.data.status} is not publishable`);
  }

  const actions: McpPublicationAction[] = [];
  const hostLocalPaths: string[] = [];
  const capturePaths = new Set(parsed.data.outputs.taskCapturePaths ?? []);
  const changedFiles = [...new Set(parsed.data.changedFiles)].sort((left, right) => left.localeCompare(right));
  const collectorMode = parsed.data.mode === "collector-packet";

  if (collectorMode) {
    const packetPath = parsed.data.outputs.packetPath;
    const expectedPacketPath = `queries/${input.runDate}-agent-memory-trends-packet.md`;
    const packetPaths = changedFiles.filter((path) => PACKET_RE.test(path));
    const digestPaths = changedFiles.filter((path) => DIGEST_RE.test(path));
    if (packetPath !== expectedPacketPath || packetPaths.length !== 1 || packetPaths[0] !== packetPath) {
      return err("MANIFEST_INVALID", "collector-packet mode requires exactly one declared packet_path");
    }
    if (digestPaths.length > 0 || parsed.data.outputs.digestPath) {
      return err("PATH_DENIED", "collector-packet mode cannot publish or declare a digest");
    }
    if (capturePaths.size > 0) {
      return err("PATH_DENIED", "collector-packet mode cannot publish captures");
    }
  }

  for (const path of changedFiles) {
    if (collectorMode && path === parsed.data.outputs.packetPath) {
      const body = readVaultFile(read, input.vault, path);
      if (!body.ok) return body;
      actions.push({ tool: "wiki_page_publish", path, content: body.data });
      continue;
    }
    if (collectorMode && CAPTURE_RE.test(path)) {
      return err("PATH_DENIED", `${path} is forbidden in collector-packet mode`);
    }
    if (path === parsed.data.outputs.digestPath && DIGEST_RE.test(path)) {
      const body = readVaultFile(read, input.vault, path);
      if (!body.ok) return body;
      actions.push({ tool: "wiki_page_publish", path, content: body.data });
      continue;
    }
    if (path === SESSION_BRIEF_PATH && path === parsed.data.outputs.sessionBriefPath) {
      const body = readVaultFile(read, input.vault, path);
      if (!body.ok) return body;
      actions.push({ tool: "wiki_page_publish", path, content: body.data });
      continue;
    }
    if (capturePaths.has(path) && CAPTURE_RE.test(path)) {
      const body = readVaultFile(read, input.vault, path);
      if (!body.ok) return body;
      const capture = parseRenderedCapture(body.data, path, input.project);
      if (!capture.ok) return capture;
      actions.push({ tool: "wiki_capture", path, ...capture.data });
      continue;
    }
    if (isHostLocalGeneratedPath(path, input.runDate)) {
      hostLocalPaths.push(path);
      continue;
    }
    return err("PATH_DENIED", `${path} cannot be published by the locked HTTP MCP write plane`);
  }

  return ok({ actions, hostLocalPaths, quietRun: actions.length === 0 });
}

export async function publishGeneratedOutputsToMcp(
  input: PublishGeneratedOutputsToMcpInput
): Promise<Result<PublishGeneratedOutputsToMcpOutput>> {
  const plan = planMcpPublication(input);
  if (!plan.ok) return plan;

  const publishedPaths: string[] = [];
  for (const action of plan.data.actions) {
    if (action.tool === "wiki_capture") {
      const receipt = await input.callTool("wiki_capture", {
        kind: action.kind,
        project: action.project,
        title: action.title,
        content: action.content,
        agent_note: `Generated by agent-memory-trends from host-local staging path ${action.path}.`,
      });
      if (!receipt.ok) return err(receipt.error, receipt);
      const receiptPath = typeof receipt.path === "string" ? receipt.path : action.path;
      publishedPaths.push(receiptPath);
      continue;
    }

    const published = await publishPageWithCas(input.callTool, action.path, action.content);
    if (!published.ok) return published;
    publishedPaths.push(action.path);
  }

  const status = await input.callTool("wiki_status", {});
  if (!status.ok) return err(status.error, status);
  const writerId = typeof status.writer_id === "string" ? status.writer_id : "";
  if (!writerId) return err("MCP_RECEIPT_INVALID", "wiki_status omitted writer_id");
  if (input.expectedWriterId && writerId !== input.expectedWriterId) {
    return err("MCP_WRITER_MISMATCH", `expected ${input.expectedWriterId}, received ${writerId}`);
  }

  return ok({
    publishedPaths,
    hostLocalPaths: plan.data.hostLocalPaths,
    writerId,
    quietRun: plan.data.quietRun,
  });
}

export async function publishSinglePageToMcp(
  input: PublishSinglePageToMcpInput
): Promise<Result<PublishSinglePageToMcpOutput>> {
  const published = await publishPageWithCas(input.callTool, input.path, input.content);
  if (!published.ok) return published;
  const status = await input.callTool("wiki_status", {});
  if (!status.ok) return err(status.error, status);
  const writerId = typeof status.writer_id === "string" ? status.writer_id : "";
  if (!writerId) return err("MCP_RECEIPT_INVALID", "wiki_status omitted writer_id");
  if (input.expectedWriterId && writerId !== input.expectedWriterId) {
    return err("MCP_WRITER_MISMATCH", `expected ${input.expectedWriterId}, received ${writerId}`);
  }
  return ok({ path: input.path, writerId });
}

export function createHttpMcpToolCaller(input: {
  url: string;
  token: string;
  fetchImpl?: typeof fetch;
}): McpToolCaller {
  const fetchImpl = input.fetchImpl ?? fetch;
  let initialized = false;
  let requestId = 1;

  const post = async (body: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const response = await fetchImpl(input.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.token}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify(body),
    });
    if (!response.ok && response.status !== 202) {
      return { ok: false, error: "MCP_HTTP_FAILED", message: `HTTP ${response.status}` };
    }
    if (response.status === 202) return { ok: true };
    return (await response.json()) as Record<string, unknown>;
  };

  const initialize = async (): Promise<McpToolResult> => {
    if (initialized) return { ok: true };
    const response = await post({
      jsonrpc: "2.0",
      id: requestId++,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "agent-memory-trends", version: "1" },
      },
    });
    if (isJsonRpcError(response)) return { ok: false, error: "MCP_INITIALIZE_FAILED", message: rpcErrorMessage(response) };
    const ready = await post({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
    if (isJsonRpcError(ready)) return { ok: false, error: "MCP_INITIALIZE_FAILED", message: rpcErrorMessage(ready) };
    initialized = true;
    return { ok: true };
  };

  return async (name, args) => {
    const ready = await initialize();
    if (!ready.ok) return ready;
    const response = await post({
      jsonrpc: "2.0",
      id: requestId++,
      method: "tools/call",
      params: { name, arguments: args },
    });
    if (isJsonRpcError(response)) return { ok: false, error: "MCP_CALL_FAILED", message: rpcErrorMessage(response) };
    return decodeToolResult(response);
  };
}

async function publishPageWithCas(callTool: McpToolCaller, path: string, content: string): Promise<Result<{ path: string }>> {
  let current = await callTool("wiki_read_page", { path });
  if (!current.ok && current.error !== "FILE_NOT_FOUND") return err(current.error, current);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const baseSha = current.ok && typeof current.sha256 === "string" ? current.sha256 : undefined;
    const write = await callTool("wiki_page_publish", {
      path,
      content,
      ...(baseSha ? { base_sha256: baseSha } : {}),
    });
    if (write.ok) return ok({ path });
    if (write.error !== "FILE_CHANGED" || attempt === 1) return err(write.error, write);
    current = await callTool("wiki_read_page", { path });
    if (!current.ok) return err(current.error, current);
  }
  return err("FILE_CHANGED", path);
}

function parseRenderedCapture(
  body: string,
  path: string,
  fallbackProject: string
): Result<{ kind: "task" | "idea" | "bug" | "note"; project: string; title: string; content: string }> {
  const match = body.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return err("CAPTURE_INVALID", `${path} has no YAML frontmatter`);
  const raw = loadYaml(match[1] ?? "");
  const frontmatter = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const pathKind = CAPTURE_RE.exec(path)?.[1];
  const kind = typeof frontmatter.kind === "string" ? frontmatter.kind : pathKind;
  if (kind !== "task" && kind !== "idea" && kind !== "bug" && kind !== "note") {
    return err("CAPTURE_INVALID", `${path} has unsupported capture kind`);
  }
  const projectValue = typeof frontmatter.project === "string" ? frontmatter.project : fallbackProject;
  const project = projectValue.replace(/^\[\[/, "").replace(/\]\]$/, "");
  const markdown = match[2] ?? "";
  const titleMatch = markdown.match(/^#\s+(.+)$/m);
  const title = titleMatch?.[1]?.trim() ?? "";
  if (!title) return err("CAPTURE_INVALID", `${path} has no H1 title`);
  const content = markdown.replace(/^#\s+.+\n+/, "").trim();
  if (!content) return err("CAPTURE_INVALID", `${path} has no capture body`);
  return ok({ kind, project, title, content });
}

function isHostLocalGeneratedPath(path: string, runDate: string): boolean {
  return (
    path === `.skillwiki/agent-memory-trends/${runDate}-input.json` ||
    path === `.skillwiki/agent-memory-trends/${runDate}-run.json` ||
    path === ".skillwiki/agent-memory-trends/latest-run.json" ||
    path === ".skillwiki/session-brief.md" ||
    path === ".skillwiki/session-brief.json" ||
    new RegExp(`^raw/articles/${runDate}-agent-memory-trends-evidence(?:-[A-Za-z0-9.+-]+)?\\.md$`).test(path)
  );
}

function readVaultFile(read: (path: string) => string, vault: string, path: string): Result<string> {
  try {
    return ok(read(join(vault, path)));
  } catch (error) {
    return err("OUTPUT_READ_FAILED", error instanceof Error ? error.message : String(error));
  }
}

function isJsonRpcError(response: Record<string, unknown>): boolean {
  return Boolean(response.error && typeof response.error === "object");
}

function rpcErrorMessage(response: Record<string, unknown>): string {
  const error = response.error;
  if (!error || typeof error !== "object") return "unknown JSON-RPC error";
  const message = (error as { message?: unknown }).message;
  return typeof message === "string" ? message : "unknown JSON-RPC error";
}

function decodeToolResult(response: Record<string, unknown>): McpToolResult {
  const result = response.result;
  if (!result || typeof result !== "object") return { ok: false, error: "MCP_RECEIPT_INVALID" };
  const structured = (result as { structuredContent?: unknown }).structuredContent;
  if (structured && typeof structured === "object" && !Array.isArray(structured)) return structured as McpToolResult;
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return { ok: false, error: "MCP_RECEIPT_INVALID" };
  const text = content.find((block) => block && typeof block === "object" && (block as { type?: unknown }).type === "text");
  const value = text && typeof (text as { text?: unknown }).text === "string" ? (text as { text: string }).text : "";
  try {
    return JSON.parse(value) as McpToolResult;
  } catch {
    return { ok: false, error: "MCP_RECEIPT_INVALID" };
  }
}
