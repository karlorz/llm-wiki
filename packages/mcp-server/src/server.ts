import { GetObjectCommand, PutObjectCommand, S3Client, S3ServiceException } from "@aws-sdk/client-s3";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { loadTokenMap, resolveWriter, unauthorizedHeaders, type TokenMap } from "./auth.js";
import { handleConsoleRequest, isConsolePath, isConsoleRequestAllowed } from "./console.js";
import { loadConfig, type McpDaemonConfig } from "./config.js";
import {
  mcpInitializeProtocolError,
  mcpPromptsListBeforeInitializeError,
  mcpResourcesListBeforeInitializeError,
  mcpResourcesReadBeforeInitializeError,
  mcpToolsCallBeforeInitializeError,
  mcpToolsListBeforeInitializeError,
} from "./mcp-initialize.js";
import { ChangedEventHub } from "./events.js";
import { MCP_INSTRUCTIONS } from "./mcp-instructions.js";
import { getIssuer, handleOAuthRequest, type OAuthConfig } from "./oauth.js";
import { FileOAuthStore, type OAuthStore } from "./oauth-store.js";
import { rcloneCopyUpdate, ReconcileGate } from "./reconcile.js";
import {
  handleWikiContext,
  handleWikiMemoryRecall,
  handleWikiQuery,
  handleWikiReadPage,
  handleWikiStatus,
  MAX_READ_PAGE_BYTES,
} from "./tools/reads.js";
import { CAPTURE_KINDS, wikiCapture, wikiLogAppend, wikiPagePublish, wikiWorkitemWrite } from "./tools/writes.js";
import { S3PutError, type PutObject } from "./txn.js";
import { type GetObject, type S3Adapter } from "./versions.js";

export interface HttpServerOptions {
  bind: string;
  port: number;
  vaultDir: string;
  tokenMap: TokenMap;
  tokenMapPath?: string;
  gate: ReconcileGate;
  putObject: PutObject;
  getObject?: GetObject;
  hub?: ChangedEventHub;
  s3Ok?: boolean;
  auditFile?: string;
  oauth?: OAuthConfig;
}

const MAX_MCP_BODY_BYTES = 1048576; // 1 MiB

const MCP_TOOL_NAMES = [
  "wiki_query",
  "wiki_read_page",
  "wiki_memory_recall",
  "wiki_status",
  "wiki_context",
  "wiki_capture",
  "wiki_log_append",
  "wiki_workitem_write",
  "wiki_page_publish",
] as const;

function json(res: ServerResponse, status: number, body: unknown, extra?: Record<string, string>): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
    ...extra,
  });
  res.end(payload);
}

class PayloadTooLargeError extends Error {
  code = "PAYLOAD_TOO_LARGE";
}

function readBody(req: IncomingMessage, limit = MAX_MCP_BODY_BYTES): Promise<string> {
  return new Promise((resolveBody, reject) => {
    let size = 0;
    let exceeded = false;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        exceeded = true;
        // drain remaining bytes so socket completes cleanly
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (exceeded) {
        reject(new PayloadTooLargeError("request body exceeds 1 MiB limit"));
      } else {
        resolveBody(Buffer.concat(chunks).toString("utf8"));
      }
    });
    req.on("error", reject);
  });
}

export function toolResult(data: unknown, isError = false) {
  return {
    structuredContent: data as Record<string, unknown>,
    content: [{ type: "text" as const, text: JSON.stringify(data) }],
    ...(isError ? { isError: true as const } : {}),
  };
}

function mcpServerPackageVersion(): string {
  return (
    JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      version: string;
    }
  ).version;
}

export function createWikiMcpServer(opts: HttpServerOptions & { hostId: string }): McpServer {
  const server = new McpServer(
    { name: "skillwiki-mcp", version: mcpServerPackageVersion() },
    { instructions: MCP_INSTRUCTIONS },
  );
  const ctx = {
    vaultDir: opts.vaultDir,
    hostId: opts.hostId,
    gate: opts.gate,
    putObject: opts.putObject,
    getObject: opts.getObject,
    auditFile: opts.auditFile,
    onCommit: (paths: string[]) => opts.hub?.emitChanged(paths),
  };
  const reads = {
    vaultDir: opts.vaultDir,
    hostId: opts.hostId,
    gate: opts.gate,
    getObject: opts.getObject,
    s3Ok: opts.s3Ok,
  };

  const failureShape = {
    ok: z.boolean(),
    error: z.string().optional(),
    message: z.string().optional(),
    path: z.string().optional(),
    currentVersion: z.string().optional(),
  };

  server.registerTool(
    "wiki_query",
    {
      description:
        "Ranked vault query. Default scope is typed knowledge only. Use scope=work or scope=all for Layer-3 work items; wiki_context lists active work. Optional project must be a vault slug; unknown or empty project fail closed.",
      inputSchema: z.object({
        query: z.string().min(1),
        limit: z.number().int().positive().optional(),
        include_pending: z.boolean().optional(),
        scope: z.enum(["typed", "work", "all"]).optional(),
        project: z.string().optional(),
      }),
      outputSchema: z.object({
        ...failureShape,
        results: z.array(z.unknown()).optional(),
      }).passthrough(),
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const out = await handleWikiQuery(reads, args);
      return toolResult(out, !out.ok);
    },
  );

  server.registerTool(
    "wiki_read_page",
    {
      description:
        "Read a vault page as markdown + frontmatter + sha256 of file bytes. Optional tail_bytes (1..262144) returns the last n bytes of an oversized page without raising PAGE_TOO_LARGE.",
      inputSchema: z.object({
        path: z.string().min(1),
        tail_bytes: z.number().int().min(1).max(MAX_READ_PAGE_BYTES).optional(),
      }),
      outputSchema: z.object({
        ...failureShape,
        markdown: z.string().optional(),
        frontmatter: z.record(z.unknown()).optional(),
        sha256: z.string().optional(),
        byte_length: z.number().optional(),
        s3_verified: z.boolean().optional(),
      }).passthrough(),
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const out = await handleWikiReadPage(reads, args);
      return toolResult(out, !out.ok);
    },
  );

  server.registerTool(
    "wiki_memory_recall",
    {
      description: "Recall distilled memory items for a project topic.",
      inputSchema: z.object({
        project: z.string().min(1),
        topic: z.string().min(1),
        scope: z.enum(["project", "global", "all"]).optional(),
      }),
      outputSchema: z.object({
        ...failureShape,
        memories: z.array(z.unknown()).optional(),
      }).passthrough(),
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const out = await handleWikiMemoryRecall(reads, args);
      return toolResult(out, !out.ok);
    },
  );

  server.registerTool(
    "wiki_status",
    {
      description:
        "Vault health snapshot plus daemon reconcile and S3 connectivity. Optional host_id must match the authenticated writer; unknown or missing host identity fail closed.",
      inputSchema: z.object({
        host_id: z.string().optional(),
      }),
      outputSchema: z.object({
        ...failureShape,
        vault_path: z.string().optional(),
        reconcile_ready: z.boolean().optional(),
        s3_ok: z.boolean().optional(),
        writer_id: z.string().optional(),
        host_id: z.string().optional(),
        fleet: z
          .object({
            identity_status: z.enum(["known", "unknown", "invalid"]),
            manifest_loaded: z.boolean(),
            host_id: z.string().optional(),
            source: z.string().optional(),
          })
          .optional(),
      }).passthrough(),
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const out = await handleWikiStatus(reads, args);
      return toolResult(out, !out.ok);
    },
  );

  server.registerTool(
    "wiki_context",
    {
      description:
        "Compact activation context, active project work-item directories, and writer metadata. Optional project slug filters to one vault project; unknown or empty project fail closed.",
      inputSchema: z.object({
        project: z.string().optional(),
      }),
      outputSchema: z.object({
        ...failureShape,
        projects: z
          .array(
            z.object({
              slug: z.string(),
              active_work: z.array(z.string()),
            }),
          )
          .optional(),
        writer_id: z.string().optional(),
        reconcile_ready: z.boolean().optional(),
        tools: z.array(z.string()).optional(),
        cas_protocol: z.string().optional(),
        capture_kinds: z.array(z.string()).optional(),
        compact_activation: z
          .object({
            instructions_sha256: z.string(),
            instructions_bytes: z.number(),
          })
          .optional(),
      }).passthrough(),
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const out = await handleWikiContext(reads, { tools: [...MCP_TOOL_NAMES], project: args.project });
      return toolResult(out, !out.ok);
    },
  );

  server.registerTool(
    "wiki_capture",
    {
      description: "Create a new ad-hoc capture under raw/transcripts/. Cannot overwrite existing pages.",
      inputSchema: z.object({
        kind: z.enum(CAPTURE_KINDS),
        project: z.string().min(1),
        title: z.string().min(1),
        content: z.string().min(1),
        agent_note: z.string().optional(),
      }),
      outputSchema: z.object({
        ...failureShape,
        path: z.string().optional(),
        writer_id: z.string().optional(),
      }).passthrough(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async (args) => {
      const out = await wikiCapture(ctx, args);
      return toolResult(out, !out.ok);
    },
  );

  server.registerTool(
    "wiki_log_append",
    {
      description:
        "Append-only structural log.md entry. Writes a skillwiki-log-event/v1 record first, then a projection block. Success returns a receipt; verify via wiki_read_page(event_path). Optional operation_id is 64 hex.",
      inputSchema: z.object({
        content: z.string().min(1),
        operation_id: z.string().regex(/^[0-9a-f]{64}$/).optional(),
      }),
      outputSchema: z.object({
        ...failureShape,
        appended: z.boolean().optional(),
        operation_id: z.string().optional(),
        event_path: z.string().optional(),
        appended_sha256: z.string().optional(),
        event_sha256: z.string().optional(),
        log_sha256: z.string().optional(),
        s3_verified: z.boolean().optional(),
        projection_repaired: z.boolean().optional(),
      }).passthrough(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async (args) => {
      const out = await wikiLogAppend(ctx, args);
      return toolResult(out, !out.ok);
    },
  );

  server.registerTool(
    "wiki_workitem_write",
    {
      description:
        "Create or overwrite an allowlisted work-item or Layer-3 workspace file (projects/*/work/**, projects/*/knowledge.md, projects/*/README.md, projects/*/architecture/**, projects/*/requirements/**, projects/*/compound/** — .md only). Overwrites require base_sha256 of the last read bytes.",
      inputSchema: z.object({
        path: z.string().min(1),
        content: z.string().min(1),
        base_sha256: z.string().optional(),
      }),
      outputSchema: z.object({
        ...failureShape,
      }).passthrough(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
        idempotentHint: true,
      },
    },
    async (args) => {
      const out = await wikiWorkitemWrite(ctx, args);
      return toolResult(out, !out.ok);
    },
  );

  server.registerTool(
    "wiki_page_publish",
    {
      description:
        "Create or overwrite an allowlisted typed page (concepts|entities|comparisons|queries|meta). Overwrites require base_sha256 of the last read bytes.",
      inputSchema: z.object({
        path: z.string().min(1),
        content: z.string().min(1),
        base_sha256: z.string().optional(),
      }),
      outputSchema: z.object({
        ...failureShape,
      }).passthrough(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
        idempotentHint: true,
      },
    },
    async (args) => {
      const out = await wikiPagePublish(ctx, args);
      return toolResult(out, !out.ok);
    },
  );

  return server;
}

async function streamToBuffer(stream: unknown): Promise<Buffer> {
  if (stream && typeof stream === "object" && "transformToByteArray" in stream) {
    const fn = (stream as { transformToByteArray: () => Promise<Uint8Array> }).transformToByteArray;
    if (typeof fn === "function") {
      const arr = await fn.call(stream);
      return Buffer.from(arr);
    }
  }
  if (stream && typeof stream === "object" && Symbol.asyncIterator in stream) {
    const chunks: Buffer[] = [];
    for await (const chunk of stream as AsyncIterable<Uint8Array | string>) {
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }
  if (Buffer.isBuffer(stream)) {
    return stream;
  }
  throw new Error("unsupported S3 stream body");
}

export function createS3Adapter(cfg: McpDaemonConfig): S3Adapter {
  if (!(cfg.s3Endpoint && cfg.s3Bucket && cfg.s3AccessKeyId && cfg.s3SecretAccessKey)) {
    throw new Error("S3 endpoint, bucket, and credentials are required; writes fail closed");
  }
  const client = new S3Client({
    endpoint: cfg.s3Endpoint,
    region: cfg.s3Region,
    credentials: {
      accessKeyId: cfg.s3AccessKeyId,
      secretAccessKey: cfg.s3SecretAccessKey,
    },
    forcePathStyle: true,
  });

  const resolveKey = (relPath: string) => [cfg.s3Prefix, relPath].filter((p) => p && p.length > 0).join("/");

  const putObject: PutObject = async (relPath, body) => {
    try {
      await client.send(
        new PutObjectCommand({
          Bucket: cfg.s3Bucket,
          Key: resolveKey(relPath),
          Body: body,
        }),
      );
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      throw new S3PutError(message, error);
    }
  };

  const getObject: GetObject = async (relPath) => {
    try {
      const res = await client.send(
        new GetObjectCommand({
          Bucket: cfg.s3Bucket,
          Key: resolveKey(relPath),
        }),
      );
      if (!res.Body) return null;
      const body = await streamToBuffer(res.Body);
      return { body };
    } catch (error: unknown) {
      if (error instanceof S3ServiceException || (error && typeof error === "object" && "name" in error)) {
        const name = (error as { name?: string }).name;
        if (name === "NoSuchKey" || name === "NotFound") {
          return null;
        }
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new S3PutError(message, error);
    }
  };

  return { putObject, getObject };
}

export function createPutObject(cfg: McpDaemonConfig): PutObject {
  return createS3Adapter(cfg).putObject;
}

export async function startMcpHttpServer(opts: HttpServerOptions): Promise<ReturnType<typeof createServer>> {
  const hub = opts.hub ?? new ChangedEventHub({ pingMs: 30_000 });
  const oauthEnabled = Boolean(opts.oauth?.enabled);
  if (oauthEnabled && !opts.oauth?.store && !opts.oauth?.stateDir) {
    throw new Error("oauth.enabled requires oauth.state_dir or an injected store");
  }
  const oauthStore: OAuthStore | undefined = oauthEnabled
    ? opts.oauth?.store ?? (opts.oauth?.stateDir ? new FileOAuthStore(opts.oauth.stateDir) : undefined)
    : undefined;

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const host = req.headers.host ?? "127.0.0.1";
    const issuer = getIssuer(req, opts.oauth?.issuer);
    const url = new URL(req.url ?? "/", `http://${host}`);
    const path = url.pathname;

    if (req.method === "GET" && (path === "/health" || path === "/mcp/health")) {
      json(res, 200, { ok: true, reconcile_ready: opts.gate.ready });
      return;
    }

    if (req.method === "GET" && path === "/favicon.ico") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (oauthEnabled && oauthStore && opts.oauth) {
      const isOauthPath =
        path === "/.well-known/oauth-protected-resource" ||
        path === "/.well-known/oauth-authorization-server" ||
        path === "/register" ||
        path === "/authorize" ||
        path === "/token";

      if (isOauthPath) {
        let rawBody = "";
        if (req.method === "POST") {
          try {
            rawBody = await readBody(req);
          } catch (err) {
            if (err instanceof PayloadTooLargeError) {
              json(res, 413, { error: "payload_too_large", message: err.message });
              return;
            }
            throw err;
          }
        }
        const handled = await handleOAuthRequest(req, res, rawBody, opts.oauth, oauthStore);
        if (handled) return;
      }
    }

    if (isConsolePath(path)) {
      if (!isConsoleRequestAllowed(req)) {
        json(res, 404, { error: "not_found" });
        return;
      }
      await handleConsoleRequest(req, res, url, {
        tokenMap: opts.tokenMap,
        tokenMapPath: opts.tokenMapPath,
        auditFile: opts.auditFile,
      });
      return;
    }

    const isMcpOrEvent =
      path === "/mcp" ||
      path === "/mcp/" ||
      path === "/events" ||
      path === "/mcp/events";

    if (!isMcpOrEvent) {
      json(res, 404, { error: "not_found" });
      return;
    }

    const authHeader = typeof req.headers.authorization === "string" ? req.headers.authorization : undefined;
    const resolved = await resolveWriter(authHeader, {
      tokenMap: opts.tokenMap,
      oauthStore,
    });

    if (!resolved) {
      const prmUrl = oauthEnabled ? `${issuer}/.well-known/oauth-protected-resource` : undefined;
      json(res, 401, { error: "unauthorized" }, unauthorizedHeaders(prmUrl));
      return;
    }

    const hostId = resolved.writerId;

    if (req.method === "GET" && (path === "/events" || path === "/mcp/events")) {
      hub.subscribe(res);
      return;
    }

    if (path === "/mcp" || path === "/mcp/") {
      let parsed: unknown;
      if (req.method === "POST") {
        let raw: string;
        try {
          raw = await readBody(req);
        } catch (err) {
          if (err instanceof PayloadTooLargeError) {
            json(res, 413, { error: "payload_too_large", message: err.message });
            return;
          }
          throw err;
        }
        try {
          parsed = raw.length > 0 ? JSON.parse(raw) : undefined;
        } catch {
          json(res, 400, { error: "invalid_json" });
          return;
        }
        const initErr = mcpInitializeProtocolError(parsed);
        if (initErr) {
          json(res, 200, initErr);
          return;
        }
        const listErr = mcpToolsListBeforeInitializeError(parsed);
        if (listErr) {
          json(res, 200, listErr);
          return;
        }
        const callErr = mcpToolsCallBeforeInitializeError(parsed);
        if (callErr) {
          json(res, 200, callErr);
          return;
        }
        const resourcesErr = mcpResourcesListBeforeInitializeError(parsed);
        if (resourcesErr) {
          json(res, 200, resourcesErr);
          return;
        }
        const promptsErr = mcpPromptsListBeforeInitializeError(parsed);
        if (promptsErr) {
          json(res, 200, promptsErr);
          return;
        }
        const resourcesReadErr = mcpResourcesReadBeforeInitializeError(parsed);
        if (resourcesReadErr) {
          json(res, 200, resourcesReadErr);
          return;
        }
      }
      const mcp = createWikiMcpServer({ ...opts, hostId, hub });
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      res.on("close", () => {
        void transport.close();
        void mcp.close();
      });
      await mcp.connect(transport);
      await transport.handleRequest(req, res, parsed);
      return;
    }

    json(res, 404, { error: "not_found" });
  });

  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(opts.port, opts.bind, () => {
      server.off("error", reject);
      resolveListen();
    });
  });
  return server;
}

export async function main(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  let fileText: string | undefined;
  if (env.SKILLWIKI_MCP_CONFIG) {
    fileText = readFileSync(env.SKILLWIKI_MCP_CONFIG, "utf8");
  }
  const cfg = loadConfig(env, fileText);
  const tokenMap = loadTokenMap(cfg.tokenMapPath);
  const gate = new ReconcileGate(() =>
    rcloneCopyUpdate({
      remote: cfg.rcloneRemote,
      bucket: cfg.rcloneBucket,
      vaultDir: cfg.vaultDir,
      timeoutMs: cfg.rcloneTimeoutMs,
    }),
  );
  const hub = new ChangedEventHub({ pingMs: cfg.ssePingMs });
  const s3Adapter = createS3Adapter(cfg);

  const server = await startMcpHttpServer({
    bind: cfg.bind,
    port: cfg.port,
    vaultDir: cfg.vaultDir,
    tokenMap,
    tokenMapPath: cfg.tokenMapPath,
    gate,
    putObject: s3Adapter.putObject,
    getObject: s3Adapter.getObject,
    hub,
    auditFile: cfg.auditLogPath,
    oauth: cfg.oauth,
  });

  void gate.runFirst().catch((error: unknown) => {
    console.error("skillwiki-mcp reconcile failed:", error);
  });
  if (cfg.reconcileIntervalMs > 0) {
    const timer = setInterval(() => {
      void gate.runPeriodic().catch((error: unknown) => {
        console.error("skillwiki-mcp periodic reconcile failed:", error);
      });
    }, cfg.reconcileIntervalMs);
    timer.unref?.();
  }

  const addr = server.address();
  console.error(`skillwiki-mcp listening ${typeof addr === "object" && addr ? `${addr.address}:${addr.port}` : cfg.port}`);
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(resolve(entry)).href;
}

if (isDirectRun()) {
  main().catch((error: unknown) => {
    console.error("skillwiki-mcp fatal:", error);
    process.exit(1);
  });
}
