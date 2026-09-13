import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { bearerToken, loadTokenMap, resolveHostId, unauthorizedHeaders, type TokenMap } from "./auth.js";
import { loadConfig, type McpDaemonConfig } from "./config.js";
import { ChangedEventHub } from "./events.js";
import { rcloneCopyUpdate, ReconcileGate } from "./reconcile.js";
import { handleWikiMemoryRecall, handleWikiQuery, handleWikiReadPage, handleWikiStatus } from "./tools/reads.js";
import { wikiCapture, wikiLogAppend, wikiPagePublish, wikiWorkitemWrite } from "./tools/writes.js";
import { type PutObject } from "./txn.js";

export interface HttpServerOptions {
  bind: string;
  port: number;
  vaultDir: string;
  tokenMap: TokenMap;
  gate: ReconcileGate;
  putObject: PutObject;
  hub?: ChangedEventHub;
  s3Ok?: boolean;
  auditFile?: string;
}

const MAX_MCP_BODY_BYTES = 1048576; // 1 MiB

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
  const server = new McpServer({ name: "skillwiki-mcp", version: mcpServerPackageVersion() });
  const ctx = {
    vaultDir: opts.vaultDir,
    hostId: opts.hostId,
    gate: opts.gate,
    putObject: opts.putObject,
    auditFile: opts.auditFile,
    onCommit: (paths: string[]) => opts.hub?.emitChanged(paths),
  };
  const reads = { vaultDir: opts.vaultDir, gate: opts.gate, s3Ok: opts.s3Ok };

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
      description: "Ranked vault query over typed knowledge (read-only).",
      inputSchema: z.object({
        query: z.string().min(1),
        limit: z.number().int().positive().optional(),
        include_pending: z.boolean().optional(),
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
      description: "Read a vault page as markdown + frontmatter + sha256 of file bytes.",
      inputSchema: z.object({ path: z.string().min(1) }),
      outputSchema: z.object({
        ...failureShape,
        markdown: z.string().optional(),
        frontmatter: z.record(z.unknown()).optional(),
        sha256: z.string().optional(),
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
      description: "Vault health snapshot plus daemon reconcile and S3 connectivity.",
      inputSchema: z.object({}),
      outputSchema: z.object({
        ...failureShape,
        vault_path: z.string().optional(),
        reconcile_ready: z.boolean().optional(),
        s3_ok: z.boolean().optional(),
      }).passthrough(),
      annotations: { readOnlyHint: true },
    },
    async () => {
      const out = await handleWikiStatus(reads);
      return toolResult(out, !out.ok);
    },
  );

  server.registerTool(
    "wiki_capture",
    {
      description: "Create a new ad-hoc capture under raw/transcripts/. Cannot overwrite existing pages.",
      inputSchema: z.object({
        kind: z.enum(["task", "idea", "bug", "note"]),
        project: z.string().min(1),
        title: z.string().min(1),
        content: z.string().min(1),
        agent_note: z.string().optional(),
      }),
      outputSchema: z.object({
        ...failureShape,
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
      description: "Append-only structural log.md entry. Cannot rewrite history.",
      inputSchema: z.object({
        content: z.string().min(1),
      }),
      outputSchema: z.object({
        ...failureShape,
        appended: z.boolean().optional(),
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
        "Create or overwrite an allowlisted work-item file (projects/*/work/** or projects/*/knowledge.md). Overwrites require base_sha256 of the last read bytes.",
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

export function createPutObject(cfg: McpDaemonConfig): PutObject {
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
  return async (relPath, body) => {
    const key = [cfg.s3Prefix, relPath].filter((p) => p && p.length > 0).join("/");
    await client.send(
      new PutObjectCommand({
        Bucket: cfg.s3Bucket,
        Key: key,
        Body: body,
      }),
    );
  };
}

export async function startMcpHttpServer(opts: HttpServerOptions): Promise<ReturnType<typeof createServer>> {
  const hub = opts.hub ?? new ChangedEventHub({ pingMs: 30_000 });

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
    const path = url.pathname;

    if (req.method === "GET" && (path === "/health" || path === "/mcp/health")) {
      json(res, 200, { ok: true, reconcile_ready: opts.gate.ready });
      return;
    }

    const token = bearerToken(
      typeof req.headers.authorization === "string" ? req.headers.authorization : undefined,
    );
    const hostId = token ? resolveHostId(token, opts.tokenMap) : undefined;
    if (!hostId) {
      json(res, 401, { error: "unauthorized" }, unauthorizedHeaders());
      return;
    }

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
        parsed = raw.length > 0 ? JSON.parse(raw) : undefined;
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
  const putObject = createPutObject(cfg);

  const server = await startMcpHttpServer({
    bind: cfg.bind,
    port: cfg.port,
    vaultDir: cfg.vaultDir,
    tokenMap,
    gate,
    putObject,
    hub,
    auditFile: cfg.auditLogPath,
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
