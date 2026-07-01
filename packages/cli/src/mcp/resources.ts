import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { resolveMcpVault } from "./vault-resolve.js";
import { fetchLintBucketPage } from "./lint-bucket.js";
import { listVaultPages, type VaultPageLayer } from "./vault-pages.js";
import { fetchQueryPreview } from "./query-preview.js";
import { fetchGraphHtmlReport } from "./graph-html.js";

async function readVaultFile(vault: string, rel: string): Promise<string> {
  return readFile(join(vault, rel), "utf8");
}

async function tailLines(text: string, lines: number): Promise<string> {
  const parts = text.split(/\r?\n/);
  if (parts.length <= lines) return text;
  return parts.slice(-lines).join("\n");
}

export function registerMcpResources(server: McpServer): void {
  server.registerResource(
    "vault-schema",
    "skillwiki://vault/schema",
    { description: "Vault SCHEMA.md conventions", mimeType: "text/markdown" },
    async (uri) => {
      const v = await resolveMcpVault({});
      if (!v.ok) {
        return { contents: [{ uri: uri.href, mimeType: "text/plain", text: JSON.stringify(v) }] };
      }
      const text = await readVaultFile(v.data.vault, "SCHEMA.md");
      return { contents: [{ uri: uri.href, mimeType: "text/markdown", text }] };
    },
  );

  server.registerResource(
    "vault-index",
    "skillwiki://vault/index",
    { description: "Vault index.md catalog", mimeType: "text/markdown" },
    async (uri) => {
      const v = await resolveMcpVault({});
      if (!v.ok) {
        return { contents: [{ uri: uri.href, mimeType: "text/plain", text: JSON.stringify(v) }] };
      }
      const text = await readVaultFile(v.data.vault, "index.md");
      return { contents: [{ uri: uri.href, mimeType: "text/markdown", text }] };
    },
  );

  server.registerResource(
    "vault-log-tail",
    new ResourceTemplate("skillwiki://vault/log-tail{?lines}", {
      list: undefined,
    }),
    { description: "Trailing lines of vault log.md (query: lines, default 50)", mimeType: "text/markdown" },
    async (uri, variables) => {
      const v = await resolveMcpVault({});
      if (!v.ok) {
        return { contents: [{ uri: uri.href, mimeType: "text/plain", text: JSON.stringify(v) }] };
      }
      const rawLines = variables.lines;
      const n = typeof rawLines === "string" && rawLines.length > 0 ? parseInt(rawLines, 10) : 50;
      const lines = Number.isFinite(n) && n > 0 ? Math.min(n, 500) : 50;
      const full = await readVaultFile(v.data.vault, "log.md");
      const text = await tailLines(full, lines);
      return { contents: [{ uri: uri.href, mimeType: "text/markdown", text }] };
    },
  );

  server.registerResource(
    "project-index",
    new ResourceTemplate("skillwiki://project/{slug}/index", { list: undefined }),
    { description: "Generated project index markdown if present", mimeType: "text/markdown" },
    async (uri, { slug }) => {
      const v = await resolveMcpVault({});
      if (!v.ok) {
        return { contents: [{ uri: uri.href, mimeType: "text/plain", text: JSON.stringify(v) }] };
      }
      const rel = `projects/${String(slug)}/index.md`;
      try {
        const text = await readVaultFile(v.data.vault, rel);
        return { contents: [{ uri: uri.href, mimeType: "text/markdown", text }] };
      } catch {
        return {
          contents: [{
            uri: uri.href,
            mimeType: "text/plain",
            text: `No project index at ${rel}. Use skillwiki.project_index tool to inspect entries.`,
          }],
        };
      }
    },
  );

  server.registerResource(
    "graph-summary",
    "skillwiki://graph/summary",
    { description: "Summary of .skillwiki/graph.json (node/edge counts)", mimeType: "application/json" },
    async (uri) => {
      const v = await resolveMcpVault({});
      if (!v.ok) {
        return { contents: [{ uri: uri.href, mimeType: "text/plain", text: JSON.stringify(v) }] };
      }
      const path = join(v.data.vault, ".skillwiki", "graph.json");
      try {
        const raw = await readFile(path, "utf8");
        const graph = JSON.parse(raw) as { adjacency?: Record<string, string[]> };
        const adjacency = graph.adjacency ?? {};
        const nodes = Object.keys(adjacency);
        const edgeCount = Object.values(adjacency).reduce((acc, arr) => acc + arr.length, 0);
        const text = JSON.stringify({
          path,
          node_count: nodes.length,
          edge_count: edgeCount,
          sample_nodes: nodes.slice(0, 10),
        }, null, 2);
        return { contents: [{ uri: uri.href, mimeType: "application/json", text }] };
      } catch (e: unknown) {
        const text = JSON.stringify({
          ok: false,
          error: "GRAPH_MISSING",
          detail: String(e),
          hint: "Run skillwiki.graph_build tool first.",
        }, null, 2);
        return { contents: [{ uri: uri.href, mimeType: "application/json", text }] };
      }
    },
  );

  server.registerResource(
    "graph-report",
    new ResourceTemplate("skillwiki://graph/report{?maxNodes}", { list: undefined }),
    {
      description: "Static HTML+SVG wikilink graph report from .skillwiki/graph.json (maxNodes default 120, max 500)",
      mimeType: "text/html",
    },
    async (uri, variables) => {
      const v = await resolveMcpVault({});
      if (!v.ok) {
        return { contents: [{ uri: uri.href, mimeType: "text/plain", text: JSON.stringify(v) }] };
      }
      const maxNodes = parseInt(String(variables.maxNodes ?? "120"), 10);
      const r = await fetchGraphHtmlReport({
        vault: v.data.vault,
        maxNodes: Number.isFinite(maxNodes) ? maxNodes : 120,
      });
      if (!r.result.ok) {
        return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(r.result) }] };
      }
      return { contents: [{ uri: uri.href, mimeType: "text/html", text: r.result.data.html }] };
    },
  );

  server.registerResource(
    "vault-pages",
    new ResourceTemplate("skillwiki://vault/pages{?layer,offset,limit}", { list: undefined }),
    {
      description: "Paginated vault page paths (layer: typed|raw|work|all; default typed; limit max 200)",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      const v = await resolveMcpVault({});
      if (!v.ok) {
        return { contents: [{ uri: uri.href, mimeType: "text/plain", text: JSON.stringify(v) }] };
      }
      const layer = (variables.layer as VaultPageLayer | undefined) ?? "typed";
      const offset = parseInt(String(variables.offset ?? "0"), 10);
      const limit = parseInt(String(variables.limit ?? "50"), 10);
      const r = await listVaultPages({
        vault: v.data.vault,
        layer,
        offset: Number.isFinite(offset) ? offset : 0,
        limit: Number.isFinite(limit) ? limit : 50,
      });
      const text = JSON.stringify(r.result, null, 2);
      return { contents: [{ uri: uri.href, mimeType: "application/json", text }] };
    },
  );

  server.registerResource(
    "lint-bucket",
    new ResourceTemplate("skillwiki://lint/{bucket}{?offset,limit}", { list: undefined }),
    {
      description: "Paginated lint bucket items for one bucket kind (read-only; limit max 100)",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      const v = await resolveMcpVault({});
      if (!v.ok) {
        return { contents: [{ uri: uri.href, mimeType: "text/plain", text: JSON.stringify(v) }] };
      }
      const bucket = String(variables.bucket ?? "");
      const offset = parseInt(String(variables.offset ?? "0"), 10);
      const limit = parseInt(String(variables.limit ?? "20"), 10);
      const r = await fetchLintBucketPage({
        vault: v.data.vault,
        bucket,
        offset: Number.isFinite(offset) ? offset : 0,
        limit: Number.isFinite(limit) ? limit : 20,
      });
      const text = JSON.stringify(r.result, null, 2);
      return { contents: [{ uri: uri.href, mimeType: "application/json", text }] };
    },
  );

  server.registerResource(
    "query-preview",
    new ResourceTemplate("skillwiki://query/preview{?text,offset,limit}", { list: undefined }),
    {
      description: "Paginated slice of skillwiki.query results (text query param required; limit max 50)",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      const v = await resolveMcpVault({});
      if (!v.ok) {
        return { contents: [{ uri: uri.href, mimeType: "text/plain", text: JSON.stringify(v) }] };
      }
      const text = String(variables.text ?? "").trim();
      if (!text) {
        return {
          contents: [{
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify({ ok: false, error: "MISSING_QUERY", detail: "text query parameter required" }),
          }],
        };
      }
      const offset = parseInt(String(variables.offset ?? "0"), 10);
      const limit = parseInt(String(variables.limit ?? "10"), 10);
      const r = await fetchQueryPreview({
        vault: v.data.vault,
        text,
        offset: Number.isFinite(offset) ? offset : 0,
        limit: Number.isFinite(limit) ? limit : 10,
      });
      return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(r.result, null, 2) }] };
    },
  );
}