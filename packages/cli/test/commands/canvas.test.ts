import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { runCanvasGenerate } from "../../src/commands/canvas.js";
import { runGraphBuild } from "../../src/commands/graph.js";

const VAULT = join(__dirname, "..", "fixtures", "sample-vault");

describe("canvas generate", () => {
  function makeTempVault(): string {
    const dir = mkdtempSync(join(tmpdir(), "sw-canvas-"));
    mkdirSync(join(dir, ".skillwiki"), { recursive: true });
    return dir;
  }

  it("generates canvas from graph.json with nodes and edges", async () => {
    // Build graph first using the sample vault
    const graphOut = join(mkdtempSync(join(tmpdir(), "sw-graph-")), "graph.json");
    const graphResult = await runGraphBuild({ vault: VAULT, out: graphOut });
    expect(graphResult.exitCode).toBe(0);

    // Set up temp vault with the graph.json
    const tempVault = makeTempVault();
    const graphDir = join(tempVault, ".skillwiki");
    const graphPath = join(graphDir, "graph.json");
    writeFileSync(graphPath, readFileSync(graphOut, "utf8"));

    const r = await runCanvasGenerate({ vault: tempVault });
    expect(r.exitCode).toBe(0);

    if (r.result.ok) {
      expect(r.result.data.node_count).toBeGreaterThan(0);
      expect(r.result.data.edge_count).toBeGreaterThan(0);

      const canvasPath = r.result.data.out_path;
      expect(existsSync(canvasPath)).toBe(true);

      const canvas = JSON.parse(readFileSync(canvasPath, "utf8"));
      expect(Array.isArray(canvas.nodes)).toBe(true);
      expect(Array.isArray(canvas.edges)).toBe(true);
      expect(canvas.nodes.length).toBeGreaterThan(0);

      // Verify node structure
      const node = canvas.nodes[0];
      expect(node).toHaveProperty("id");
      expect(node).toHaveProperty("type", "file");
      expect(node).toHaveProperty("file");
      expect(node).toHaveProperty("x");
      expect(node).toHaveProperty("y");
      expect(node).toHaveProperty("width");
      expect(node).toHaveProperty("height");
      expect(node).toHaveProperty("color");

      // Verify edge structure
      if (canvas.edges.length > 0) {
        const edge = canvas.edges[0];
        expect(edge).toHaveProperty("id");
        expect(edge).toHaveProperty("fromNode");
        expect(edge).toHaveProperty("toNode");
        expect(edge).toHaveProperty("fromSide", "right");
        expect(edge).toHaveProperty("toSide", "left");
      }
    }

    rmSync(tempVault, { recursive: true, force: true });
  });

  it("returns error when graph.json is missing", async () => {
    const tempVault = makeTempVault();
    // No graph.json created

    const r = await runCanvasGenerate({ vault: tempVault });
    expect(r.exitCode).toBe(2); // FILE_NOT_FOUND
    expect(r.result.ok).toBe(false);

    if (!r.result.ok) {
      expect(r.result.error).toBe("FILE_NOT_FOUND");
    }

    rmSync(tempVault, { recursive: true, force: true });
  });

  it("output file is valid JSON with nodes and edges arrays", async () => {
    // Create a graph.json with known data
    const tempVault = makeTempVault();
    const graphData = {
      adjacency: {
        "entities/org-alpha.md": ["concepts/pattern-x.md"],
        "concepts/pattern-x.md": ["comparisons/compare-uv.md"],
        "comparisons/compare-uv.md": [],
      },
    };
    writeFileSync(join(tempVault, ".skillwiki", "graph.json"), JSON.stringify(graphData));

    const r = await runCanvasGenerate({ vault: tempVault });
    expect(r.exitCode).toBe(0);

    if (r.result.ok) {
      expect(r.result.data.node_count).toBe(3);
      expect(r.result.data.edge_count).toBe(2);

      const canvas = JSON.parse(readFileSync(r.result.data.out_path, "utf8"));
      expect(canvas.nodes).toHaveLength(3);
      expect(canvas.edges).toHaveLength(2);

      // Verify column layout: entities at x=0, concepts at x=400, comparisons at x=800
      const entityNode = canvas.nodes.find((n: any) => n.id === "entities/org-alpha.md");
      const conceptNode = canvas.nodes.find((n: any) => n.id === "concepts/pattern-x.md");
      const compareNode = canvas.nodes.find((n: any) => n.id === "comparisons/compare-uv.md");

      expect(entityNode.x).toBe(0);
      expect(conceptNode.x).toBe(400);
      expect(compareNode.x).toBe(800);

      // Verify color-coding by type
      expect(entityNode.color).toBe("1");   // red for entities
      expect(conceptNode.color).toBe("4");   // green for concepts
      expect(compareNode.color).toBe("2");   // orange for comparisons
    }

    rmSync(tempVault, { recursive: true, force: true });
  });

  it("handles custom graph-path option", async () => {
    const tempVault = mkdtempSync(join(tmpdir(), "sw-canvas-"));
    mkdirSync(join(tempVault, "_graph"), { recursive: true });
    const graphData = { adjacency: { "concepts/test.md": [] } };
    writeFileSync(join(tempVault, "_graph", "graph.json"), JSON.stringify(graphData));

    const r = await runCanvasGenerate({ vault: tempVault, graphPath: join(tempVault, "_graph", "graph.json") });
    expect(r.exitCode).toBe(0);

    if (r.result.ok) {
      expect(r.result.data.node_count).toBe(1);
      expect(r.result.data.edge_count).toBe(0);
    }

    rmSync(tempVault, { recursive: true, force: true });
  });

  it("rejects invalid JSON in graph.json", async () => {
    const tempVault = makeTempVault();
    writeFileSync(join(tempVault, ".skillwiki", "graph.json"), "not-json");

    const r = await runCanvasGenerate({ vault: tempVault });
    expect(r.exitCode).toBe(8); // SCHEMA_NOT_DETECTED
    expect(r.result.ok).toBe(false);

    rmSync(tempVault, { recursive: true, force: true });
  });

  it("rejects graph.json missing adjacency field", async () => {
    const tempVault = makeTempVault();
    writeFileSync(join(tempVault, ".skillwiki", "graph.json"), JSON.stringify({ nodes: [] }));

    const r = await runCanvasGenerate({ vault: tempVault });
    expect(r.exitCode).toBe(8); // SCHEMA_NOT_DETECTED

    rmSync(tempVault, { recursive: true, force: true });
  });

  it("assigns default column and color for unknown type paths", async () => {
    const tempVault = makeTempVault();
    const graphData = {
      adjacency: {
        "projects/my-plan.md": ["entities/something.md"],
        "entities/something.md": [],
      },
    };
    writeFileSync(join(tempVault, ".skillwiki", "graph.json"), JSON.stringify(graphData));

    const r = await runCanvasGenerate({ vault: tempVault });
    expect(r.exitCode).toBe(0);

    if (r.result.ok) {
      const canvas = JSON.parse(readFileSync(r.result.data.out_path, "utf8"));
      const projectNode = canvas.nodes.find((n: any) => n.id === "projects/my-plan.md");
      // "projects" is not in TYPE_COLUMNS/TYPE_COLORS → default column 2, default color "3"
      expect(projectNode.x).toBe(2 * 400);
      expect(projectNode.color).toBe("3");
    }

    rmSync(tempVault, { recursive: true, force: true });
  });

  it("deduplicates duplicate directed edges in adjacency", async () => {
    const tempVault = makeTempVault();
    const graphData = {
      adjacency: {
        "entities/a.md": ["concepts/b.md", "concepts/b.md"],
        "concepts/b.md": [],
      },
    };
    writeFileSync(join(tempVault, ".skillwiki", "graph.json"), JSON.stringify(graphData));

    const r = await runCanvasGenerate({ vault: tempVault });
    expect(r.exitCode).toBe(0);

    if (r.result.ok) {
      expect(r.result.data.edge_count).toBe(1);
      const canvas = JSON.parse(readFileSync(r.result.data.out_path, "utf8"));
      expect(canvas.edges).toHaveLength(1);
    }

    rmSync(tempVault, { recursive: true, force: true });
  });

  it("handles empty adjacency with zero nodes and zero edges", async () => {
    const tempVault = makeTempVault();
    writeFileSync(join(tempVault, ".skillwiki", "graph.json"), JSON.stringify({ adjacency: {} }));

    const r = await runCanvasGenerate({ vault: tempVault });
    expect(r.exitCode).toBe(0);

    if (r.result.ok) {
      expect(r.result.data.node_count).toBe(0);
      expect(r.result.data.edge_count).toBe(0);
      const canvas = JSON.parse(readFileSync(r.result.data.out_path, "utf8"));
      expect(canvas.nodes).toEqual([]);
      expect(canvas.edges).toEqual([]);
    }

    rmSync(tempVault, { recursive: true, force: true });
  });
});
