import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { runQuery } from "../commands/query.js";
import { runLint } from "../commands/lint.js";
import { runDoctor } from "../commands/doctor.js";
import { runGraphBuild } from "../commands/graph.js";
import { runProjectIndex } from "../commands/project-index.js";
import { runStale } from "../commands/stale.js";
import { runConfigGet } from "../commands/config.js";
import { readCliPackageJson } from "../utils/package-info.js";
import { resolveMcpVault, defaultGraphOut } from "./vault-resolve.js";
import { formatToolResult } from "./result-format.js";

const vaultFields = {
  vault: z.string().optional().describe("Vault root directory; omitted = resolve WIKI_PATH / default ~/wiki"),
  wiki: z.string().optional().describe("Wiki profile name for vault resolution"),
};

export function registerMcpTools(server: McpServer): void {
  server.registerTool(
    "skillwiki.query",
    {
      description: "Ranked vault query over typed knowledge (read-only). Returns Result envelope JSON.",
      inputSchema: z.object({
        ...vaultFields,
        text: z.string().min(1).describe("Query text"),
        limit: z.number().int().positive().optional().describe("Max results (default 10)"),
      }),
    },
    async ({ vault, wiki, text, limit }) => {
      const v = await resolveMcpVault({ vault, wiki });
      if (!v.ok) return formatToolResult({ exitCode: 25, result: v });
      const r = await runQuery({ vault: v.data.vault, text, limit });
      return formatToolResult(r);
    },
  );

  server.registerTool(
    "skillwiki.lint_summary",
    {
      description: "Vault lint bucket summary (read-only, no --fix). Returns Result envelope JSON.",
      inputSchema: z.object({
        ...vaultFields,
        only: z.string().optional().describe("Run a single lint bucket"),
        examplesLimit: z.number().int().nonnegative().optional().describe("Examples per bucket in summary (default 3)"),
        days: z.number().int().positive().optional().describe("Stale threshold days (default 90)"),
        lines: z.number().int().positive().optional().describe("Pagesize threshold lines (default 200)"),
        logThreshold: z.number().int().positive().optional().describe("Log rotation threshold (default 500)"),
      }),
    },
    async (args) => {
      const v = await resolveMcpVault({ vault: args.vault, wiki: args.wiki });
      if (!v.ok) return formatToolResult({ exitCode: 25, result: v });
      const r = await runLint({
        vault: v.data.vault,
        source: args.vault ? "flag" : v.data.source,
        days: args.days ?? 90,
        lines: args.lines ?? 200,
        logThreshold: args.logThreshold ?? 500,
        fix: false,
        only: args.only,
        summary: true,
        examplesLimit: args.examplesLimit ?? 3,
      });
      return formatToolResult(r);
    },
  );

  server.registerTool(
    "skillwiki.doctor",
    {
      description: "Diagnose skillwiki setup, vault path, sync, and plugin channels (read-only).",
      inputSchema: z.object({
        ...vaultFields,
      }),
    },
    async ({ vault, wiki }) => {
      await resolveMcpVault({ vault, wiki });
      const pkg = readCliPackageJson();
      const r = await runDoctor({
        home: process.env.HOME ?? "",
        envValue: process.env.WIKI_PATH,
        argv: process.argv,
        currentVersion: pkg.version,
        cwd: process.cwd(),
      });
      return formatToolResult(r);
    },
  );

  server.registerTool(
    "skillwiki.graph_build",
    {
      description: "Build wikilink graph JSON under .skillwiki/graph.json (writes graph file only).",
      inputSchema: z.object({
        ...vaultFields,
        out: z.string().optional().describe("Output path (default <vault>/.skillwiki/graph.json)"),
      }),
    },
    async ({ vault, wiki, out }) => {
      const v = await resolveMcpVault({ vault, wiki });
      if (!v.ok) return formatToolResult({ exitCode: 25, result: v });
      const outPath = out ?? defaultGraphOut(v.data.vault);
      const r = await runGraphBuild({ vault: v.data.vault, out: outPath });
      return formatToolResult(r);
    },
  );

  server.registerTool(
    "skillwiki.project_index",
    {
      description: "List project index entries for a slug (read-only, apply=false).",
      inputSchema: z.object({
        ...vaultFields,
        slug: z.string().min(1).describe("Project slug under projects/{slug}/"),
      }),
    },
    async ({ vault, wiki, slug }) => {
      const v = await resolveMcpVault({ vault, wiki });
      if (!v.ok) return formatToolResult({ exitCode: 25, result: v });
      const r = await runProjectIndex({ vault: v.data.vault, slug, apply: false });
      return formatToolResult(r);
    },
  );

  server.registerTool(
    "skillwiki.stale",
    {
      description: "List stale pages, transcripts, and incomplete work items (read-only).",
      inputSchema: z.object({
        ...vaultFields,
        days: z.number().int().positive().optional().describe("Stale age threshold (default 90)"),
        project: z.string().optional().describe("Scope to one project slug"),
      }),
    },
    async ({ vault, wiki, days, project }) => {
      const v = await resolveMcpVault({ vault, wiki });
      if (!v.ok) return formatToolResult({ exitCode: 25, result: v });
      const r = await runStale({
        vault: v.data.vault,
        days: days ?? 90,
        archive: false,
        project,
      });
      return formatToolResult(r);
    },
  );

  server.registerTool(
    "skillwiki.config_get",
    {
      description: "Read a single skillwiki config key from ~/.skillwiki/.env (read-only).",
      inputSchema: z.object({
        key: z.string().min(1).describe("Config key (e.g. WIKI_PATH or profile key)"),
      }),
    },
    async ({ key }) => {
      const r = await runConfigGet({ key, home: process.env.HOME ?? "" });
      return formatToolResult(r);
    },
  );
}