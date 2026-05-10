import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ok, err, ExitCode, type Result } from "@skillwiki/shared";

export interface CanvasGenerateInput {
  vault: string;
  graphPath?: string;
}

export interface CanvasGenerateOutput {
  out_path: string;
  node_count: number;
  edge_count: number;
  humanHint: string;
}

interface GraphData {
  adjacency: Record<string, string[]>;
  adamicAdar?: Record<string, Record<string, number>>;
}

interface CanvasNode {
  id: string;
  type: "file";
  file: string;
  x: number;
  y: number;
  width: number;
  height: number;
  color: string;
}

interface CanvasEdge {
  id: string;
  fromNode: string;
  toNode: string;
  fromSide: "right";
  toSide: "left";
}

interface CanvasFile {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
}

const NODE_WIDTH = 240;
const NODE_HEIGHT = 60;
const COLUMN_SPACING = 400;
const ROW_SPACING = 80;

const TYPE_COLUMNS: Record<string, number> = {
  entities: 0,
  concepts: 1,
  comparisons: 2,
  queries: 3,
  meta: 3,
};

const TYPE_COLORS: Record<string, string> = {
  entities: "1",    // red
  concepts: "4",    // green
  comparisons: "2", // orange
  queries: "5",     // cyan
  meta: "6",        // purple
};

const DEFAULT_COLOR = "3"; // yellow
const DEFAULT_COLUMN = 2;

function inferNodeType(relPath: string): string {
  const segment = relPath.split("/")[0] ?? "";
  return TYPE_COLUMNS[segment] !== undefined ? segment : "";
}

function getColumnForType(nodeType: string): number {
  return TYPE_COLUMNS[nodeType] ?? DEFAULT_COLUMN;
}

function getColorForType(nodeType: string): string {
  return TYPE_COLORS[nodeType] ?? DEFAULT_COLOR;
}

function buildCanvasNodes(paths: string[]): CanvasNode[] {
  // Group paths by type to compute y positions per column
  const columnY: Record<number, number> = {};
  const nodes: CanvasNode[] = [];

  for (const relPath of paths) {
    const nodeType = inferNodeType(relPath);
    const col = getColumnForType(nodeType);
    const y = columnY[col] ?? 0;
    columnY[col] = y + ROW_SPACING;

    nodes.push({
      id: relPath,
      type: "file",
      file: relPath,
      x: col * COLUMN_SPACING,
      y,
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
      color: getColorForType(nodeType),
    });
  }

  return nodes;
}

function buildCanvasEdges(adjacency: Record<string, string[]>): CanvasEdge[] {
  const edges: CanvasEdge[] = [];
  let edgeIndex = 0;
  const seen = new Set<string>();

  for (const [source, targets] of Object.entries(adjacency)) {
    for (const target of targets) {
      // Deduplicate directed edges (adjacency may have bidirectional entries)
      const key = `${source}->${target}`;
      if (seen.has(key)) continue;
      seen.add(key);

      edges.push({
        id: `edge-${edgeIndex++}`,
        fromNode: source,
        toNode: target,
        fromSide: "right",
        toSide: "left",
      });
    }
  }

  return edges;
}

export async function runCanvasGenerate(
  input: CanvasGenerateInput
): Promise<{ exitCode: number; result: Result<CanvasGenerateOutput> }> {
  const graphPath = input.graphPath ?? join(input.vault, ".skillwiki", "graph.json");

  if (!existsSync(graphPath)) {
    return {
      exitCode: ExitCode.FILE_NOT_FOUND,
      result: err("FILE_NOT_FOUND", {
        path: graphPath,
        hint: "Run `skillwiki graph build` first to generate graph.json",
      }),
    };
  }

  let raw: string;
  try {
    raw = await readFile(graphPath, "utf8");
  } catch (e: unknown) {
    return {
      exitCode: ExitCode.FILE_NOT_FOUND,
      result: err("FILE_NOT_FOUND", { path: graphPath, message: String(e) }),
    };
  }

  let graph: GraphData;
  try {
    graph = JSON.parse(raw);
  } catch {
    return {
      exitCode: ExitCode.SCHEMA_NOT_DETECTED,
      result: err("SCHEMA_NOT_DETECTED", { path: graphPath, reason: "Invalid JSON in graph.json" }),
    };
  }

  if (!graph.adjacency || typeof graph.adjacency !== "object") {
    return {
      exitCode: ExitCode.SCHEMA_NOT_DETECTED,
      result: err("SCHEMA_NOT_DETECTED", { path: graphPath, reason: "graph.json missing adjacency field" }),
    };
  }

  const paths = Object.keys(graph.adjacency);
  const nodes = buildCanvasNodes(paths);
  const edges = buildCanvasEdges(graph.adjacency);

  const canvas: CanvasFile = { nodes, edges };
  const outPath = join(input.vault, "vault-graph.canvas");

  try {
    await writeFile(outPath, JSON.stringify(canvas, null, 2));
  } catch (e: unknown) {
    return {
      exitCode: ExitCode.WRITE_FAILED,
      result: err("WRITE_FAILED", { message: String(e), path: outPath }),
    };
  }

  return {
    exitCode: ExitCode.OK,
    result: ok({
      out_path: outPath,
      node_count: nodes.length,
      edge_count: edges.length,
      humanHint: `nodes: ${nodes.length}, edges: ${edges.length}\nwritten: ${outPath}`,
    }),
  };
}
