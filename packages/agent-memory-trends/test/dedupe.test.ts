import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { collectDuplicateSignals, evaluateDuplicateCandidate } from "../src/dedupe.js";
import { buildAgentInput, writeAgentInput } from "../src/input.js";
import type { SelectedGithubCandidate } from "../src/github.js";

function makeVault(): string {
  const vault = mkdtempSync(join(tmpdir(), "agent-memory-trends-vault-"));
  mkdirSync(join(vault, "raw", "transcripts"), { recursive: true });
  mkdirSync(join(vault, "projects", "llm-wiki", "work", "2026-06-01-existing-memory"), { recursive: true });
  mkdirSync(join(vault, "queries"), { recursive: true });

  writeFileSync(
    join(vault, "raw", "transcripts", "2026-06-01-task-local-agent-memory.md"),
    [
      "---",
      "title: Local agent memory adapter",
      "kind: task",
      'project: "[[llm-wiki]]"',
      "source_url: https://github.com/acme/local-agent-memory",
      "ingested: 2026-06-01",
      "---",
      "",
      "Stage a task for `acme/local-agent-memory`.",
      "",
    ].join("\n"),
    "utf8"
  );

  writeFileSync(
    join(vault, "raw", "transcripts", "2026-06-01-task-other-project.md"),
    [
      "---",
      "title: Other project task",
      "kind: task",
      'project: "[[portfolio-lab]]"',
      "source_url: https://github.com/acme/ignored",
      "ingested: 2026-06-01",
      "---",
      "",
    ].join("\n"),
    "utf8"
  );

  writeFileSync(
    join(vault, "projects", "llm-wiki", "work", "2026-06-01-existing-memory", "spec.md"),
    [
      "---",
      "title: MCP memory bridge",
      "name: mcp-memory-bridge",
      "description: Build from https://github.com/acme/mcp-memory-bridge",
      "kind: feature",
      "status: planned",
      'project: "[[llm-wiki]]"',
      "---",
      "",
      "# MCP Memory Bridge",
      "",
      "Implement support for acme/mcp-memory-bridge.",
      "",
    ].join("\n"),
    "utf8"
  );

  for (let day = 1; day <= 32; day += 1) {
    const date = `2026-05-${String(day).padStart(2, "0")}`;
    writeFileSync(
      join(vault, "queries", `${date}-agent-memory-trends-digest.md`),
      [
        "---",
        `title: Agent memory trends digest ${date}`,
        "type: query",
        "---",
        "",
        `# Digest ${date}`,
        "",
        "Mentions https://github.com/acme/digest-memory.",
        "",
      ].join("\n"),
      "utf8"
    );
  }

  return vault;
}

function candidate(overrides: Partial<SelectedGithubCandidate>): SelectedGithubCandidate {
  return {
    name: "new-memory",
    fullName: "acme/new-memory",
    canonicalUrl: "https://github.com/acme/new-memory",
    description: "Agent memory for llm-wiki.",
    topics: ["agent-memory"],
    readmeText: "Markdown memory.",
    evidenceQuality: {
      depth: "implementation_surface",
      sourceInspectionRecommended: true,
      signals: ["markdown", "sync", "memory"],
      summary: "README evidence exposes implementation surfaces: markdown, sync, memory.",
    },
    laneIds: ["weekly_momentum"],
    qualityGate: "passed",
    evidenceFamilies: ["coding_agent", "memory_state", "knowledge_store"],
    stargazersCount: 100,
    forksCount: 10,
    pushedAt: "2026-06-10T00:00:00Z",
    archived: false,
    queryIds: ["claude-agent-memory"],
    score: {
      score: 80,
      components: {
        relevance: 30,
        implementationEvidence: 20,
        authorityMomentum: 15,
        freshness: 10,
        noveltyOrTracking: 5,
      },
      trackingStatus: "new",
      reasons: ["high signal"],
    },
    ...overrides,
  };
}

describe("agent-memory-trends duplicate suppression and input generation", () => {
  it("scans llm-wiki task captures, planned work, and the latest 30 digests", () => {
    const vault = makeVault();

    const signals = collectDuplicateSignals(vault, "llm-wiki");

    expect(signals.ok).toBe(true);
    if (!signals.ok) throw new Error("expected duplicate signals");
    expect(signals.data.existingTasks).toHaveLength(1);
    expect(signals.data.existingTasks[0]).toMatchObject({
      title: "Local agent memory adapter",
      sourceUrl: "https://github.com/acme/local-agent-memory",
      repoName: "acme/local-agent-memory",
    });
    expect(signals.data.activeWork).toHaveLength(1);
    expect(signals.data.activeWork[0]).toMatchObject({
      title: "MCP memory bridge",
      status: "planned",
      repoNames: ["acme/mcp-memory-bridge"],
    });
    expect(signals.data.recentDigests).toHaveLength(30);
    expect(signals.data.recentDigests[0].path).toBe("queries/2026-05-32-agent-memory-trends-digest.md");
  });

  it("suppresses duplicate source URLs, repo names, and near-title matches", () => {
    const vault = makeVault();
    const signals = collectDuplicateSignals(vault, "llm-wiki");
    if (!signals.ok) throw new Error("expected duplicate signals");

    const bySourceUrl = evaluateDuplicateCandidate(
      candidate({ fullName: "acme/local-agent-memory", canonicalUrl: "https://github.com/acme/local-agent-memory" }),
      signals.data
    );
    expect(bySourceUrl.duplicate).toBe(true);
    expect(bySourceUrl.reasons.join("\n")).toContain("source URL");

    const byRepoName = evaluateDuplicateCandidate(
      candidate({ fullName: "acme/mcp-memory-bridge", canonicalUrl: "https://github.com/acme/mcp-memory-bridge" }),
      signals.data
    );
    expect(byRepoName.duplicate).toBe(true);
    expect(byRepoName.reasons.join("\n")).toContain("repo name");

    const byTitle = evaluateDuplicateCandidate(candidate({ name: "MCP memory bridge" }), signals.data);
    expect(byTitle.duplicate).toBe(true);
    expect(byTitle.reasons.join("\n")).toContain("near-title");

    const novel = evaluateDuplicateCandidate(candidate({ fullName: "acme/novel-memory", name: "Novel memory sync" }), signals.data);
    expect(novel.duplicate).toBe(false);
  });

  it("writes dated Codex input JSON with selected candidates, duplicate suppressions, and allowed outputs", () => {
    const vault = makeVault();
    const selectedCandidates = [
      candidate({ fullName: "acme/local-agent-memory", canonicalUrl: "https://github.com/acme/local-agent-memory" }),
      candidate({ fullName: "acme/novel-memory", canonicalUrl: "https://github.com/acme/novel-memory" }),
    ];

    const input = buildAgentInput({
      vault,
      repo: "/repo/llm-wiki",
      project: "llm-wiki",
      runDate: "2026-06-11",
      runId: "2026-06-11T00-10-00+08-00",
      selectedCandidates,
      allowedOutputs: {
        evidencePath: "raw/articles/2026-06-11-agent-memory-trends-evidence.md",
        digestPath: "queries/2026-06-11-agent-memory-trends-digest.md",
        taskCaptureGlob: "raw/transcripts/2026-06-11-task-*.md",
        manifestPath: ".skillwiki/agent-memory-trends/2026-06-11-run.json",
      },
    });

    expect(input.ok).toBe(true);
    if (!input.ok) throw new Error("expected input");
    expect(input.data.selectedCandidates).toHaveLength(1);
    expect(input.data.selectedCandidates[0].fullName).toBe("acme/novel-memory");
    expect(input.data.duplicateSuppressions).toHaveLength(1);
    expect(input.data.existingTasks).toHaveLength(1);
    expect(input.data.recentDigests).toHaveLength(30);

    const written = writeAgentInput(input.data);
    expect(written.ok).toBe(true);
    if (!written.ok) throw new Error("expected input write");
    expect(written.data.path).toBe(join(vault, ".skillwiki", "agent-memory-trends", "2026-06-11-input.json"));

    const json = JSON.parse(readFileSync(written.data.path, "utf8"));
    expect(json.run_id).toBe("2026-06-11T00-10-00+08-00");
    expect(json.selected_candidates).toHaveLength(1);
    expect(json.selected_candidates[0]).toMatchObject({
      full_name: "acme/novel-memory",
      lane_ids: ["weekly_momentum"],
      quality_gate: "passed",
      evidence_families: ["coding_agent", "memory_state", "knowledge_store"],
      evidence_quality: {
        depth: "implementation_surface",
        source_inspection_recommended: true,
        signals: ["markdown", "sync", "memory"],
        summary: "README evidence exposes implementation surfaces: markdown, sync, memory.",
      },
      score: {
        components: {
          implementation_evidence: 20,
          authority_momentum: 15,
          novelty_or_tracking: 5,
        },
        tracking_status: "new",
      },
    });
    expect(json.duplicate_suppressions[0].candidate.full_name).toBe("acme/local-agent-memory");
    expect(json.allowed_outputs.manifest_path).toBe(".skillwiki/agent-memory-trends/2026-06-11-run.json");
  });
});
