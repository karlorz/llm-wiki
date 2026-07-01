import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { ok, err, ExitCode, type Result } from "@skillwiki/shared";

export interface GraphHtmlReportInput {
  vault: string;
  graphPath?: string;
  maxNodes?: number;
}

export interface GraphHtmlReportOutput {
  html: string;
  node_count: number;
  edge_count: number;
  truncated: boolean;
  graph_path: string;
}

const TYPE_COLORS: Record<string, string> = {
  entities: "#e74c3c",
  concepts: "#27ae60",
  comparisons: "#e67e22",
  queries: "#3498db",
  meta: "#9b59b6",
};

function nodeColor(relPath: string): string {
  const seg = relPath.split("/")[0] ?? "";
  return TYPE_COLORS[seg] ?? "#f1c40f";
}

function shortLabel(relPath: string): string {
  const base = relPath.split("/").pop() ?? relPath;
  return base.replace(/\.md$/, "");
}

/** Self-contained HTML+SVG wikilink graph report (no external JS). */
export function buildGraphHtmlFromAdjacency(
  adjacency: Record<string, string[]>,
  maxNodes: number,
): { html: string; node_count: number; edge_count: number; truncated: boolean } {
  const allNodes = Object.keys(adjacency).sort();
  const truncated = allNodes.length > maxNodes;
  const nodes = truncated ? allNodes.slice(0, maxNodes) : allNodes;
  const nodeSet = new Set(nodes);

  const edges: Array<{ from: string; to: string }> = [];
  const seen = new Set<string>();
  for (const from of nodes) {
    for (const to of adjacency[from] ?? []) {
      if (!nodeSet.has(to)) continue;
      const key = `${from}->${to}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ from, to });
    }
  }

  const cols = 4;
  const cellW = 220;
  const cellH = 36;
  const pad = 40;
  const positions = new Map<string, { x: number; y: number }>();
  nodes.forEach((n, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    positions.set(n, { x: pad + col * cellW, y: pad + row * cellH });
  });

  const width = pad * 2 + cols * cellW;
  const rows = Math.ceil(nodes.length / cols) || 1;
  const height = pad * 2 + rows * cellH + 60;

  const edgeSvg = edges
    .map(({ from, to }) => {
      const a = positions.get(from)!;
      const b = positions.get(to)!;
      return `<line x1="${a.x + 100}" y1="${a.y + 14}" x2="${b.x + 100}" y2="${b.y + 14}" stroke="#95a5a6" stroke-width="1" opacity="0.6"/>`;
    })
    .join("\n");

  const nodeSvg = nodes
    .map((n) => {
      const p = positions.get(n)!;
      const label = shortLabel(n).replace(/&/g, "&amp;").replace(/</g, "&lt;");
      const title = n.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
      return `<g transform="translate(${p.x},${p.y})"><title>${title}</title><rect width="200" height="28" rx="4" fill="${nodeColor(n)}" opacity="0.85"/><text x="8" y="18" font-size="11" fill="#fff" font-family="system-ui,sans-serif">${label}</text></g>`;
    })
    .join("\n");

  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"/><title>SkillWiki graph report</title>
<style>body{font-family:system-ui,sans-serif;margin:1rem;background:#1e1e1e;color:#eee}h1{font-size:1.1rem}p{color:#aaa;font-size:0.85rem}</style></head>
<body><h1>Vault wikilink graph</h1>
<p>Nodes: ${nodes.length}${truncated ? ` (truncated from ${allNodes.length})` : ""} · Edges: ${edges.length}</p>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
${edgeSvg}
${nodeSvg}
</svg></body></html>`;

  return { html, node_count: nodes.length, edge_count: edges.length, truncated };
}

export async function fetchGraphHtmlReport(
  input: GraphHtmlReportInput,
): Promise<{ exitCode: number; result: Result<GraphHtmlReportOutput> }> {
  const graphPath = input.graphPath ?? join(input.vault, ".skillwiki", "graph.json");
  const maxNodes = Math.min(Math.max(10, input.maxNodes ?? 120), 500);

  if (!existsSync(graphPath)) {
    return {
      exitCode: ExitCode.FILE_NOT_FOUND,
      result: err("GRAPH_MISSING", { path: graphPath, hint: "Run skillwiki.graph_build first." }),
    };
  }

  let raw: string;
  try {
    raw = await readFile(graphPath, "utf8");
  } catch (e: unknown) {
    return {
      exitCode: ExitCode.FILE_NOT_FOUND,
      result: err("GRAPH_MISSING", { path: graphPath, detail: String(e) }),
    };
  }

  let adjacency: Record<string, string[]>;
  try {
    const parsed = JSON.parse(raw) as { adjacency?: Record<string, string[]> };
    adjacency = parsed.adjacency ?? {};
  } catch {
    return {
      exitCode: ExitCode.SCHEMA_NOT_DETECTED,
      result: err("SCHEMA_NOT_DETECTED", { path: graphPath }),
    };
  }

  const built = buildGraphHtmlFromAdjacency(adjacency, maxNodes);
  return {
    exitCode: ExitCode.OK,
    result: ok({
      html: built.html,
      node_count: built.node_count,
      edge_count: built.edge_count,
      truncated: built.truncated,
      graph_path: graphPath,
    }),
  };
}