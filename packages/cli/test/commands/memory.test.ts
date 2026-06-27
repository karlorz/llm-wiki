import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMemoryImport, runMemoryIndex, runMemoryRecall, runMemoryTopics } from "../../src/commands/memory.js";

async function makeVault(): Promise<string> {
  const vault = await mkdtemp(join(tmpdir(), "memory-topics-vault-"));
  writeFileSync(join(vault, "SCHEMA.md"), "# Schema\n");
  writeFileSync(join(vault, "index.md"), "# Index\n");
  writeFileSync(join(vault, "log.md"), "# Log\n");
  mkdirSync(join(vault, ".skillwiki"), { recursive: true });
  mkdirSync(join(vault, "concepts"), { recursive: true });
  mkdirSync(join(vault, "raw", "transcripts"), { recursive: true });
  mkdirSync(join(vault, "projects", "llm-wiki", "compound"), { recursive: true });
  return vault;
}

function writeMemoryConcept(
  vault: string,
  file: string,
  extraFrontmatter: string,
  body: string,
  options: { provenanceProjects?: string[] } = {}
): void {
  const provenanceProjects = options.provenanceProjects ?? ["[[llm-wiki]]"];
  writeFileSync(join(vault, "concepts", file), `---
title: ${file.replace(/\.md$/, "")}
created: 2026-06-19
updated: 2026-06-19
type: concept
tags: [memory]
sources: [raw/transcripts/2026-06-19-memory-source.md]
confidence: high
provenance: project
provenance_projects: ${JSON.stringify(provenanceProjects)}
${extraFrontmatter.trimEnd()}
---

${body}
`);
}

describe("runMemoryTopics", () => {
  it("returns an empty read-only topic list when the derived cache is absent", async () => {
    const vault = await makeVault();

    const result = await runMemoryTopics({ vault });

    expect(result.exitCode).toBe(0);
    expect(result.result.ok).toBe(true);
    if (!result.result.ok) throw new Error("expected ok");
    expect(result.result.data.cache_present).toBe(false);
    expect(result.result.data.topics).toEqual([]);
    expect(result.result.data.files_written).toEqual([]);
    expect(existsSync(join(vault, ".skillwiki", "memory-topics.json"))).toBe(false);
  });

  it("filters, sorts, and limits topics from the derived cache", async () => {
    const vault = await makeVault();
    writeFileSync(join(vault, ".skillwiki", "memory-topics.json"), `${JSON.stringify({
      generated_at: "2026-06-19T00:00:00Z",
      topics: [
        {
          name: "vault-sync",
          summary: "Vault sync safety patterns.",
          project: "llm-wiki",
          updated: "2026-06-17",
          paths: ["projects/llm-wiki/architecture/2026-05-23-vault-sync-topology.md"],
        },
        {
          name: "session-brief",
          summary: "Startup memory and topic retrieval boundary.",
          project: "llm-wiki",
          updated: "2026-06-19",
          paths: [
            "concepts/agent-memory-control-loop.md",
            "projects/llm-wiki/compound/session-brief-nightly-refresh-boundary.md",
          ],
        },
        {
          name: "other-project-memory",
          summary: "Memory topic from a different project.",
          project: "zzapi-mes",
          updated: "2026-06-20",
          paths: ["concepts/other.md"],
        },
      ],
    }, null, 2)}\n`, "utf8");

    const result = await runMemoryTopics({ vault, project: "llm-wiki", limit: 1 });

    expect(result.exitCode).toBe(0);
    expect(result.result.ok).toBe(true);
    if (!result.result.ok) throw new Error("expected ok");
    expect(result.result.data.cache_present).toBe(true);
    expect(result.result.data.generated_at).toBe("2026-06-19T00:00:00Z");
    expect(result.result.data.topics).toEqual([
      {
        name: "session-brief",
        summary: "Startup memory and topic retrieval boundary.",
        project: "llm-wiki",
        updated: "2026-06-19",
        paths: [
          "concepts/agent-memory-control-loop.md",
          "projects/llm-wiki/compound/session-brief-nightly-refresh-boundary.md",
        ],
      },
    ]);
    expect(result.result.data.humanHint).toContain("session-brief");
    expect(result.result.data.humanHint).not.toContain("zzapi-mes");
  });

  it("ignores malformed topic entries instead of failing the read-only command", async () => {
    const vault = await makeVault();
    writeFileSync(join(vault, ".skillwiki", "memory-topics.json"), `${JSON.stringify({
      topics: [
        { name: "valid-topic", summary: "Usable topic.", updated: "2026-06-19", paths: ["concepts/valid.md"] },
        { summary: "Missing name.", updated: "2026-06-19" },
      ],
    }, null, 2)}\n`, "utf8");

    const result = await runMemoryTopics({ vault });

    expect(result.exitCode).toBe(0);
    expect(result.result.ok).toBe(true);
    if (!result.result.ok) throw new Error("expected ok");
    expect(result.result.data.topics.map((topic) => topic.name)).toEqual(["valid-topic"]);
  });

  it("indexes memory metadata into a rebuildable project topic cache", async () => {
    const vault = await makeVault();
    writeMemoryConcept(vault, "session-brief-memory.md", `memory_kind: workflow
memory_topics: [session-brief, agent-memory]
memory_scope: project
memory_policy: operational
memory_privacy: local
memory_status: active
last_seen: 2026-06-19`, "Session brief memory should stay bounded and point to lazy recall.");

    const result = await runMemoryIndex({ vault, project: "llm-wiki" });

    expect(result.exitCode).toBe(0);
    expect(result.result.ok).toBe(true);
    if (!result.result.ok) throw new Error("expected ok");
    expect(result.result.data.files_written).toEqual([".skillwiki/memory/llm-wiki/topics.json"]);
    expect(result.result.data.topic_count).toBe(2);
    expect(result.result.data.source_count).toBe(1);

    const cache = JSON.parse(readFileSync(join(vault, ".skillwiki", "memory", "llm-wiki", "topics.json"), "utf8"));
    expect(cache.project).toBe("llm-wiki");
    expect(cache.topics.map((topic: { name: string }) => topic.name)).toEqual(["agent-memory", "session-brief"]);
    expect(cache.sources[0].path).toBe("concepts/session-brief-memory.md");
    expect(cache.sources[0].hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("skips invalid topic slugs with warnings", async () => {
    const vault = await makeVault();
    writeMemoryConcept(vault, "bad-topic-memory.md", `memory_kind: workflow
memory_topics: ["Bad Topic", good-topic]
memory_privacy: public
memory_status: active`, "Only the lowercase slug should be indexed.");

    const result = await runMemoryIndex({ vault, project: "llm-wiki" });

    expect(result.exitCode).toBe(0);
    expect(result.result.ok).toBe(true);
    if (!result.result.ok) throw new Error("expected ok");
    expect(result.result.data.warnings).toContain("concepts/bad-topic-memory.md: invalid memory topic slug Bad Topic");
    expect(result.result.data.topics.map((topic) => topic.name)).toEqual(["good-topic"]);
  });

  it("excludes secret-blocked memories from index and recall output", async () => {
    const vault = await makeVault();
    writeMemoryConcept(vault, "secret-memory.md", `memory_kind: warning
memory_topics: [secret-topic]
memory_privacy: secret-blocked
memory_status: active`, "This source must not be returned.");

    const index = await runMemoryIndex({ vault, project: "llm-wiki" });
    const recall = await runMemoryRecall({ vault, project: "llm-wiki", topic: "secret-topic" });

    expect(index.exitCode).toBe(0);
    expect(index.result.ok).toBe(true);
    if (!index.result.ok) throw new Error("expected ok");
    expect(index.result.data.topic_count).toBe(0);
    expect(index.result.data.source_count).toBe(0);
    expect(index.result.data.warnings).toContain("concepts/secret-memory.md: skipped secret-blocked memory");

    expect(recall.exitCode).toBe(0);
    expect(recall.result.ok).toBe(true);
    if (!recall.result.ok) throw new Error("expected ok");
    expect(recall.result.data.sources).toEqual([]);
    expect(recall.result.data.humanHint).toBe("no memory sources found for topic secret-topic");
  });

  it("recalls bounded topic sources from the project cache", async () => {
    const vault = await makeVault();
    writeMemoryConcept(vault, "session-brief-memory.md", `memory_kind: workflow
memory_topics: [session-brief]
memory_scope: project
memory_policy: operational
memory_privacy: local
memory_status: active`, "Session brief memory should stay bounded and point to lazy recall.");
    writeMemoryConcept(vault, "older-session-brief-memory.md", `memory_kind: convention
memory_topics: [session-brief]
memory_scope: project
memory_policy: advisory
memory_privacy: public
memory_status: active
last_seen: 2026-06-17`, "Older session brief memory should sort after the current source.");
    await runMemoryIndex({ vault, project: "llm-wiki" });

    const result = await runMemoryRecall({ vault, project: "llm-wiki", topic: "session-brief", limit: 1 });

    expect(result.exitCode).toBe(0);
    expect(result.result.ok).toBe(true);
    if (!result.result.ok) throw new Error("expected ok");
    expect(result.result.data.topic).toBe("session-brief");
    expect(result.result.data.sources).toHaveLength(1);
    expect(result.result.data.sources[0].path).toBe("concepts/session-brief-memory.md");
    expect(result.result.data.humanHint).toContain("concepts/session-brief-memory.md");
    expect(result.result.data.humanHint).not.toContain("older-session-brief-memory");
  });

  it("filters recall sources by explicit memory scope while preserving omitted-scope behavior", async () => {
    const vault = await makeVault();
    writeMemoryConcept(vault, "project-agent-memory.md", `memory_kind: workflow
memory_topics: [agent-memory]
memory_scope: project
memory_policy: operational
memory_privacy: local
memory_status: active
last_seen: 2026-06-21`, "Project memory for the local llm-wiki workflow.");
    writeMemoryConcept(vault, "global-agent-memory.md", `memory_kind: convention
memory_topics: [agent-memory]
memory_scope: global
memory_policy: advisory
memory_privacy: public
memory_status: active
last_seen: 2026-06-21`, "Global memory that is not tied to one project.", { provenanceProjects: [] });
    writeMemoryConcept(vault, "cross-agent-memory.md", `memory_kind: handoff
memory_topics: [agent-memory]
memory_scope: cross-agent
memory_policy: operational
memory_privacy: local
memory_status: active
last_seen: 2026-06-21`, "Cross-agent memory shared between assistant surfaces.", { provenanceProjects: [] });
    await runMemoryIndex({ vault, project: "llm-wiki" });

    const omitted = await runMemoryRecall({ vault, project: "llm-wiki", topic: "agent-memory" });
    const project = await runMemoryRecall({ vault, project: "llm-wiki", topic: "agent-memory", scope: "project" });
    const global = await runMemoryRecall({ vault, project: "llm-wiki", topic: "agent-memory", scope: "global" });
    const crossAgent = await runMemoryRecall({ vault, project: "llm-wiki", topic: "agent-memory", scope: "cross-agent" });
    const all = await runMemoryRecall({ vault, project: "llm-wiki", topic: "agent-memory", scope: "all" });

    for (const result of [omitted, project, global, crossAgent, all]) {
      expect(result.exitCode).toBe(0);
      expect(result.result.ok).toBe(true);
    }
    if (!omitted.result.ok || !project.result.ok || !global.result.ok || !crossAgent.result.ok || !all.result.ok) {
      throw new Error("expected ok");
    }

    expect(omitted.result.data.scope).toBeUndefined();
    expect(omitted.result.data.sources.map((source) => source.path).sort()).toEqual([
      "concepts/cross-agent-memory.md",
      "concepts/global-agent-memory.md",
      "concepts/project-agent-memory.md",
    ]);
    expect(project.result.data.scope).toBe("project");
    expect(project.result.data.sources.map((source) => source.path)).toEqual(["concepts/project-agent-memory.md"]);
    expect(global.result.data.scope).toBe("global");
    expect(global.result.data.sources.map((source) => source.path)).toEqual(["concepts/global-agent-memory.md"]);
    expect(crossAgent.result.data.scope).toBe("cross-agent");
    expect(crossAgent.result.data.sources.map((source) => source.path)).toEqual(["concepts/cross-agent-memory.md"]);
    expect(all.result.data.scope).toBe("all");
    expect(all.result.data.sources.map((source) => source.path)).toEqual([
      "concepts/project-agent-memory.md",
      "concepts/cross-agent-memory.md",
      "concepts/global-agent-memory.md",
    ]);
    expect(all.result.data.sources[0]).toMatchObject({
      project: "llm-wiki",
      memory_scope: "project",
      memory_policy: "operational",
      memory_privacy: "local",
      memory_status: "active",
    });
    expect(all.result.data.sources[0].hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects invalid memory recall scopes with a Result error", async () => {
    const vault = await makeVault();

    const result = await runMemoryRecall({ vault, project: "llm-wiki", topic: "agent-memory", scope: "invalid" });

    expect(result.exitCode).toBe(10);
    expect(result.result.ok).toBe(false);
    if (result.result.ok) throw new Error("expected error");
    expect(result.result.error).toBe("WRITE_FAILED");
    expect(result.result.detail?.path).toBe("memory recall --scope");
  });

  it("reports missing memory index cache as advisory stale status without writing", async () => {
    const vault = await makeVault();
    writeMemoryConcept(vault, "missing-cache-memory.md", `memory_kind: workflow
memory_topics: [agent-memory]
memory_scope: project
memory_privacy: local
memory_status: active`, "A source exists but the local cache has not been built.");

    const result = await runMemoryIndex({ vault, project: "llm-wiki", check: true });

    expect(result.exitCode).toBe(0);
    expect(result.result.ok).toBe(true);
    if (!result.result.ok) throw new Error("expected ok");
    expect(result.result.data.cache_present).toBe(false);
    expect(result.result.data.stale).toBe(true);
    expect(result.result.data.source_count).toBe(1);
    expect(result.result.data.topic_count).toBe(1);
    expect(result.result.data.files_written).toEqual([]);
    expect(existsSync(join(vault, ".skillwiki", "memory", "llm-wiki", "topics.json"))).toBe(false);
  });

  it("reports a current memory index cache as not stale", async () => {
    const vault = await makeVault();
    writeMemoryConcept(vault, "current-cache-memory.md", `memory_kind: workflow
memory_topics: [agent-memory]
memory_scope: project
memory_privacy: local
memory_status: active`, "The local cache should match this source.");
    await runMemoryIndex({ vault, project: "llm-wiki" });

    const result = await runMemoryIndex({ vault, project: "llm-wiki", check: true });

    expect(result.exitCode).toBe(0);
    expect(result.result.ok).toBe(true);
    if (!result.result.ok) throw new Error("expected ok");
    expect(result.result.data.cache_present).toBe(true);
    expect(result.result.data.stale).toBe(false);
    expect(result.result.data.drift).toEqual({
      missing_sources: [],
      removed_sources: [],
      changed_sources: [],
    });
    expect(result.result.data.files_written).toEqual([]);
  });

  it("reports source hash drift without rewriting the cache", async () => {
    const vault = await makeVault();
    writeMemoryConcept(vault, "drift-cache-memory.md", `memory_kind: workflow
memory_topics: [agent-memory]
memory_scope: project
memory_privacy: local
memory_status: active`, "The original memory body.");
    await runMemoryIndex({ vault, project: "llm-wiki" });
    const cachePath = join(vault, ".skillwiki", "memory", "llm-wiki", "topics.json");
    const before = readFileSync(cachePath, "utf8");
    writeMemoryConcept(vault, "drift-cache-memory.md", `memory_kind: workflow
memory_topics: [agent-memory]
memory_scope: project
memory_privacy: local
memory_status: active`, "The changed memory body.");

    const result = await runMemoryIndex({ vault, project: "llm-wiki", check: true });

    expect(result.exitCode).toBe(0);
    expect(result.result.ok).toBe(true);
    if (!result.result.ok) throw new Error("expected ok");
    expect(result.result.data.stale).toBe(true);
    expect(result.result.data.drift.changed_sources).toEqual(["concepts/drift-cache-memory.md"]);
    expect(result.result.data.files_written).toEqual([]);
    expect(readFileSync(cachePath, "utf8")).toBe(before);
  });

  it("ignores privacy-filtered sources while checking memory index freshness", async () => {
    const vault = await makeVault();
    writeMemoryConcept(vault, "public-cache-memory.md", `memory_kind: workflow
memory_topics: [agent-memory]
memory_scope: project
memory_privacy: local
memory_status: active`, "This source should be indexed.");
    writeMemoryConcept(vault, "secret-cache-memory.md", `memory_kind: warning
memory_topics: [agent-memory]
memory_scope: project
memory_privacy: secret-blocked
memory_status: active`, "This source should never make the cache stale.");
    await runMemoryIndex({ vault, project: "llm-wiki" });

    const result = await runMemoryIndex({ vault, project: "llm-wiki", check: true });

    expect(result.exitCode).toBe(0);
    expect(result.result.ok).toBe(true);
    if (!result.result.ok) throw new Error("expected ok");
    expect(result.result.data.source_count).toBe(1);
    expect(result.result.data.stale).toBe(false);
    expect(result.result.data.drift.missing_sources).toEqual([]);
  });

  it("rebuilds a memory index only when --if-stale sees missing or stale cache", async () => {
    const vault = await makeVault();
    writeMemoryConcept(vault, "if-stale-cache-memory.md", `memory_kind: workflow
memory_topics: [agent-memory]
memory_scope: project
memory_privacy: local
memory_status: active`, "The cache starts missing and should be written once.");

    const missing = await runMemoryIndex({ vault, project: "llm-wiki", ifStale: true });
    expect(missing.exitCode).toBe(0);
    expect(missing.result.ok).toBe(true);
    if (!missing.result.ok) throw new Error("expected ok");
    expect(missing.result.data.cache_present).toBe(false);
    expect(missing.result.data.stale).toBe(true);
    expect(missing.result.data.files_written).toEqual([".skillwiki/memory/llm-wiki/topics.json"]);

    const cachePath = join(vault, ".skillwiki", "memory", "llm-wiki", "topics.json");
    const before = readFileSync(cachePath, "utf8");
    const current = await runMemoryIndex({ vault, project: "llm-wiki", ifStale: true });

    expect(current.exitCode).toBe(0);
    expect(current.result.ok).toBe(true);
    if (!current.result.ok) throw new Error("expected ok");
    expect(current.result.data.cache_present).toBe(true);
    expect(current.result.data.stale).toBe(false);
    expect(current.result.data.files_written).toEqual([]);
    expect(readFileSync(cachePath, "utf8")).toBe(before);
  });

  it("returns the existing invalid-cache error for memory index freshness checks", async () => {
    const vault = await makeVault();
    mkdirSync(join(vault, ".skillwiki", "memory", "llm-wiki"), { recursive: true });
    writeFileSync(join(vault, ".skillwiki", "memory", "llm-wiki", "topics.json"), "{bad json", "utf8");

    const result = await runMemoryIndex({ vault, project: "llm-wiki", check: true });

    expect(result.exitCode).toBe(10);
    expect(result.result.ok).toBe(false);
    if (result.result.ok) throw new Error("expected error");
    expect(result.result.error).toBe("WRITE_FAILED");
    expect(result.result.detail?.path).toBe(".skillwiki/memory/llm-wiki/topics.json");
  });

  it("previews local memory imports without writing vault files", async () => {
    const vault = await makeVault();
    const source = await mkdtemp(join(tmpdir(), "memory-import-source-"));
    mkdirSync(join(source, ".codex", "memories"), { recursive: true });
    writeFileSync(join(source, ".codex", "memories", "workflow.md"), "Prefer bounded memory recall before broad search.\n");

    const result = await runMemoryImport({ vault, from: source, project: "llm-wiki", apply: false });

    expect(result.exitCode).toBe(0);
    expect(result.result.ok).toBe(true);
    if (!result.result.ok) throw new Error("expected ok");
    expect(result.result.data.applied).toBe(false);
    expect(result.result.data.manifest.entries).toHaveLength(1);
    expect(result.result.data.manifest.entries[0].status).toBe("ready");
    expect(result.result.data.files_written).toEqual([]);
    expect(existsSync(join(vault, "raw", "transcripts", "2026-06-19-memory-import-workflow.md"))).toBe(false);
  });

  it("returns a Result error instead of throwing when the import source is missing", async () => {
    const vault = await makeVault();
    const result = await runMemoryImport({ vault, from: join(vault, "missing-memory"), project: "llm-wiki" });

    expect(result.exitCode).toBe(10);
    expect(result.result.ok).toBe(false);
    if (result.result.ok) throw new Error("expected error");
    expect(result.result.error).toBe("WRITE_FAILED");
    expect(result.result.detail?.path).toBe(join(vault, "missing-memory"));
  });

  it("applies redacted imports as validated raw captures without leaking secrets", async () => {
    const vault = await makeVault();
    const source = await mkdtemp(join(tmpdir(), "memory-import-secret-"));
    mkdirSync(join(source, ".codex", "memories"), { recursive: true });
    const secret = "sk-" + "A".repeat(48);
    writeFileSync(join(source, ".codex", "memories", "secret-workflow.md"), `Use this workflow.\napi_key: ${secret}\n`);

    const result = await runMemoryImport({ vault, from: source, project: "llm-wiki", apply: true });

    expect(result.exitCode).toBe(0);
    expect(result.result.ok).toBe(true);
    if (!result.result.ok) throw new Error("expected ok");
    expect(JSON.stringify(result.result.data)).not.toContain(secret);
    expect(result.result.data.files_written).toHaveLength(1);
    expect(result.result.data.manifest.entries[0].redaction_count).toBeGreaterThan(0);
    expect(result.result.data.manifest.entries[0].validation?.valid).toBe(true);

    const written = readFileSync(join(vault, result.result.data.files_written[0]), "utf8");
    expect(written).toContain("[REDACTED:");
    expect(written).not.toContain(secret);
  });

  it("imports codex memories but rejects codex rules as policy", async () => {
    const vault = await makeVault();
    const source = await mkdtemp(join(tmpdir(), "memory-import-codex-"));
    mkdirSync(join(source, ".codex", "memories"), { recursive: true });
    mkdirSync(join(source, ".codex", "rules"), { recursive: true });
    writeFileSync(join(source, ".codex", "memories", "memory.md"), "Remember this workflow.\n");
    writeFileSync(join(source, ".codex", "rules", "rule.md"), "Always obey this strict rule.\n");

    const result = await runMemoryImport({ vault, from: source, project: "llm-wiki", apply: false });

    expect(result.exitCode).toBe(0);
    expect(result.result.ok).toBe(true);
    if (!result.result.ok) throw new Error("expected ok");
    expect(result.result.data.manifest.entries.map((entry) => entry.status)).toEqual(["ready", "rejected"]);
    expect(result.result.data.manifest.entries[1].reason).toBe("policy_source_not_imported");
  });

  it("imports Claude Auto-Memory markers without mutating CLAUDE.md", async () => {
    const vault = await makeVault();
    const source = await mkdtemp(join(tmpdir(), "memory-import-claude-"));
    const claudePath = join(source, "CLAUDE.md");
    const original = [
      "# Policy",
      "Strict instruction stays policy.",
      "<!-- AUTO-MEMORY:START -->",
      "Use topic recall for agent memory work.",
      "<!-- AUTO-MEMORY:END -->",
    ].join("\n");
    writeFileSync(claudePath, original);

    const result = await runMemoryImport({ vault, from: source, project: "llm-wiki", apply: true });

    expect(result.exitCode).toBe(0);
    expect(result.result.ok).toBe(true);
    if (!result.result.ok) throw new Error("expected ok");
    expect(readFileSync(claudePath, "utf8")).toBe(original);
    expect(result.result.data.files_written).toHaveLength(1);
    const written = readFileSync(join(vault, result.result.data.files_written[0]), "utf8");
    expect(written).toContain("Use topic recall for agent memory work.");
    expect(written).not.toContain("Strict instruction stays policy.");
  });

  it("imports Napkin and memsearch markdown files", async () => {
    const vault = await makeVault();
    const source = await mkdtemp(join(tmpdir(), "memory-import-tools-"));
    mkdirSync(join(source, ".claude"), { recursive: true });
    mkdirSync(join(source, ".memsearch", "memory"), { recursive: true });
    writeFileSync(join(source, ".claude", "napkin.md"), "Napkin correction: keep imports dry-run first.\n");
    writeFileSync(join(source, ".memsearch", "memory", "2026-06-19.md"), "Memsearch daily memory: recall before expand.\n");

    const result = await runMemoryImport({ vault, from: source, project: "llm-wiki", apply: false });

    expect(result.exitCode).toBe(0);
    expect(result.result.ok).toBe(true);
    if (!result.result.ok) throw new Error("expected ok");
    expect(result.result.data.manifest.entries.map((entry) => entry.source_kind).sort()).toEqual(["memsearch", "napkin"]);
  });

  it("rejects oversized memory-like logs", async () => {
    const vault = await makeVault();
    const source = await mkdtemp(join(tmpdir(), "memory-import-large-"));
    mkdirSync(join(source, ".codex", "memories"), { recursive: true });
    writeFileSync(join(source, ".codex", "memories", "huge.md"), "x".repeat(256));

    const result = await runMemoryImport({ vault, from: source, project: "llm-wiki", apply: false, maxBytes: 128 });

    expect(result.exitCode).toBe(0);
    expect(result.result.ok).toBe(true);
    if (!result.result.ok) throw new Error("expected ok");
    expect(result.result.data.manifest.entries[0].status).toBe("rejected");
    expect(result.result.data.manifest.entries[0].reason).toBe("oversized_source");
  });
});
