import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  makeDiscoveryCandidate,
  type DiscoveryCandidate,
  type DiscoveryCandidateFacts,
  type DiscoverySnapshot,
} from "../src/discovery-contracts.js";
import {
  applyDiscoveryDeltas,
  loadDiscoveryHistory,
  pruneDiscoverySnapshots,
  readDiscoverySnapshot,
  writeDiscoveryQueue,
  writeDiscoverySnapshot,
  type DiscoveryQueueCounts,
} from "../src/discovery-snapshots.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "discovery-snapshots-test-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function makeCandidate(overrides: Partial<DiscoveryCandidateFacts> = {}): DiscoveryCandidate {
  return makeDiscoveryCandidate({
    canonicalUrl: "https://github.com/acme/repo-a",
    fullName: "acme/repo-a",
    owner: "acme",
    name: "repo-a",
    createdAt: "2026-06-01T00:00:00Z",
    pushedAt: "2026-08-13T00:00:00Z",
    stargazersCount: 120,
    forksCount: 10,
    archived: false,
    topics: ["agent-memory"],
    description: "coding agent memory",
    license: "MIT",
    defaultBranch: "main",
    sourceIds: ["lane:release_velocity", "query:release-new"],
    attentionEvidence: [{ sourceId: "hacker_news", url: "https://news.ycombinator.com/item?id=1" }],
    relevanceInput: 80,
    evidenceQualityInput: 40,
    ...overrides,
  });
}

function writeSnapshot(date: string, candidates: DiscoveryCandidate[]): void {
  const result = writeDiscoverySnapshot(dir, {
    formatVersion: 1,
    runAt: `${date}T12:00:00.000Z`,
    retentionDays: 30,
    candidates,
  });
  if (!result.ok) throw new Error(`expected snapshot write to succeed: ${String(result.detail)}`);
}

describe("agent-memory-trends discovery snapshots", () => {
  it("writes a dated snapshot plus a latest.json pointer with a deterministic field order", () => {
    const snapshot: DiscoverySnapshot = {
      formatVersion: 1,
      runAt: "2026-08-14T02:00:00.000Z",
      retentionDays: 30,
      candidates: [makeCandidate()],
    };
    const written = writeDiscoverySnapshot(dir, snapshot);
    expect(written.ok).toBe(true);
    if (!written.ok) throw new Error("expected snapshot write to succeed");

    const datedPath = join(dir, "2026-08-14.json");
    const latestPath = join(dir, "latest.json");
    expect(existsSync(datedPath)).toBe(true);
    expect(existsSync(latestPath)).toBe(true);
    expect(readFileSync(datedPath, "utf8")).toBe(readFileSync(latestPath, "utf8"));

    const parsed = JSON.parse(readFileSync(datedPath, "utf8")) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual(["formatVersion", "runAt", "retentionDays", "candidates"]);
    expect(parsed.formatVersion).toBe(1);

    const candidate = (parsed.candidates as Record<string, unknown>[])[0]!;
    const candidateKeys = Object.keys(candidate);
    expect(candidateKeys).toContain("canonicalUrl");
    expect(candidateKeys).toContain("starDelta24h");
    expect(candidateKeys).toContain("disposition");
    expect(candidateKeys).not.toContain("readmeText");
    expect(candidateKeys).not.toContain("prompt");
    expect(JSON.stringify(candidate)).not.toContain("secret");
    expect(JSON.stringify(candidate)).not.toContain("token");

    const readBack = readDiscoverySnapshot(datedPath);
    expect(readBack.ok).toBe(true);
    if (!readBack.ok) throw new Error("expected snapshot read to succeed");
    expect(readBack.data.candidates).toHaveLength(1);
    expect(readBack.data.candidates[0]!.canonicalUrl).toBe("https://github.com/acme/repo-a");
  });

  it("computes 24h and 7d star/fork deltas from prior observations and keeps first observations baseline-unknown", () => {
    writeSnapshot("2026-08-07", [
      makeCandidate({ canonicalUrl: "https://github.com/acme/repo-a", stargazersCount: 80, forksCount: 5 }),
    ]);
    writeSnapshot("2026-08-13", [
      makeCandidate({ canonicalUrl: "https://github.com/acme/repo-a", stargazersCount: 100, forksCount: 8 }),
    ]);

    const now = new Date("2026-08-14T02:00:00Z");
    const history = loadDiscoveryHistory(dir, now, 30);
    expect(history.warnings).toEqual([]);

    const current = [makeCandidate({ canonicalUrl: "https://github.com/acme/repo-a", stargazersCount: 120, forksCount: 10 })];
    const withDeltas = applyDiscoveryDeltas(current, history, now);
    expect(withDeltas[0]!.starDelta24h).toBe(20);
    expect(withDeltas[0]!.starDelta7d).toBe(40);
    expect(withDeltas[0]!.forkDelta24h).toBe(2);
    expect(withDeltas[0]!.forkDelta7d).toBe(5);

    const firstObservation = [makeCandidate({ canonicalUrl: "https://github.com/acme/repo-b", stargazersCount: 12, forksCount: 1 })];
    const firstDeltas = applyDiscoveryDeltas(firstObservation, history, now);
    expect(firstDeltas[0]!.starDelta24h).toBeNull();
    expect(firstDeltas[0]!.starDelta7d).toBeNull();
    expect(firstDeltas[0]!.forkDelta24h).toBeNull();
    expect(firstDeltas[0]!.forkDelta7d).toBeNull();

    const unchanged = [makeCandidate({ canonicalUrl: "https://github.com/acme/repo-a", stargazersCount: 100, forksCount: 8 })];
    const unchangedDeltas = applyDiscoveryDeltas(unchanged, history, now);
    expect(unchangedDeltas[0]!.starDelta24h).toBe(0);
    expect(unchangedDeltas[0]!.starDelta7d).toBe(20);
  });

  it("prunes only dated snapshot files beyond the retention window and preserves unrelated files", () => {
    writeSnapshot("2026-08-01", [makeCandidate()]);
    writeSnapshot("2026-08-07", [makeCandidate()]);
    writeSnapshot("2026-08-10", [makeCandidate()]);
    writeFileSync(join(dir, "latest.json"), "{}");
    writeFileSync(join(dir, "notes.txt"), "keep me");
    writeFileSync(join(dir, "2026-08-13.json.bak"), "{}");
    writeFileSync(join(dir, "random.json"), "{}");

    const result = pruneDiscoverySnapshots(dir, 7, new Date("2026-08-14T00:00:00Z"));

    expect(result.removed).toEqual(["2026-08-01.json", "2026-08-07.json"]);
    expect(result.kept).toEqual(["2026-08-10.json"]);
    expect(readdirSync(dir).sort()).toEqual([
      "2026-08-10.json",
      "2026-08-13.json.bak",
      "latest.json",
      "notes.txt",
      "random.json",
    ]);
  });

  it("reports malformed historical snapshots as warnings and never treats missing data as zero", () => {
    writeSnapshot("2026-08-13", [makeCandidate({ canonicalUrl: "https://github.com/acme/repo-a", stargazersCount: 100, forksCount: 8 })]);
    writeFileSync(join(dir, "2026-08-12.json"), "{ not valid json");
    writeFileSync(join(dir, "2026-08-11.json"), JSON.stringify({ formatVersion: 2, candidates: [] }));

    const now = new Date("2026-08-14T00:00:00Z");
    const history = loadDiscoveryHistory(dir, now, 30);

    expect(history.warnings).toHaveLength(2);
    expect(history.warnings.join(" ")).toContain("2026-08-12.json");
    expect(history.warnings.join(" ")).toContain("2026-08-11.json");

    const observations = history.observationsByUrl.get("https://github.com/acme/repo-a");
    expect(observations).toHaveLength(1);
    expect(observations![0]!.date).toBe("2026-08-13");
    expect(observations![0]!.stargazersCount).toBe(100);

    const read = readDiscoverySnapshot(join(dir, "2026-08-12.json"));
    expect(read.ok).toBe(false);
    if (read.ok) throw new Error("expected snapshot read to fail");
    expect(read.error).toBe("SNAPSHOT_INVALID");
  });

  it("ignores dated snapshot files outside the retention window when loading history", () => {
    writeSnapshot("2026-07-01", [makeCandidate({ canonicalUrl: "https://github.com/acme/repo-old", stargazersCount: 10, forksCount: 1 })]);
    writeSnapshot("2026-08-13", [makeCandidate({ canonicalUrl: "https://github.com/acme/repo-a", stargazersCount: 100, forksCount: 8 })]);

    const now = new Date("2026-08-14T00:00:00Z");
    const history = loadDiscoveryHistory(dir, now, 7);
    expect(history.warnings).toEqual([]);
    expect(history.observationsByUrl.has("https://github.com/acme/repo-old")).toBe(false);
    expect(history.observationsByUrl.get("https://github.com/acme/repo-a")).toHaveLength(1);
  });

  it("caps snapshot candidates at the discovery cap and redacts token-like free text before truncating", () => {
    const straddlingToken = "ghp_abcdefghijklmnopqrstuvwxyz123456";
    // The token starts just before the 200-char cap and is cut in half by
    // truncation; a truncate-then-redact serializer would persist the
    // partial secret "ghp_abcdefghij".
    const descriptionWithStraddlingSecret = `${"x".repeat(190)} ${straddlingToken}`;
    const candidates = [
      {
        ...makeCandidate({ canonicalUrl: "https://github.com/acme/repo-a" }),
        description: descriptionWithStraddlingSecret,
        topics: ["agent-memory", `GITHUB_TOKEN=${straddlingToken}`],
        sourceIds: ["lane:release_velocity", `github_pat_abcdefghijklmnopqrstuvwxyz1234567`],
        attentionEvidence: [
          {
            sourceId: "hacker_news",
            url: "https://news.ycombinator.com/item?id=1",
            title: "t".repeat(500),
            englishSummary: `HN story with ${straddlingToken}`,
          },
        ],
        reasons: [`reason with ${straddlingToken}`],
      } as unknown as DiscoveryCandidate,
      ...Array.from({ length: 24 }, (_, index) =>
        makeCandidate({ canonicalUrl: `https://github.com/acme/repo-${index}` })
      ),
    ];
    const snapshot: DiscoverySnapshot = {
      formatVersion: 1,
      runAt: "2026-08-14T02:00:00.000Z",
      retentionDays: 30,
      candidates,
    };

    const written = writeDiscoverySnapshot(dir, snapshot, 20);
    expect(written.ok).toBe(true);
    if (!written.ok) throw new Error("expected snapshot write to succeed");

    const body = readFileSync(join(dir, "2026-08-14.json"), "utf8");
    const parsed = JSON.parse(body) as { candidates: Array<Record<string, unknown>> };
    expect(parsed.candidates).toHaveLength(20);

    // Redaction happens before truncation: the token straddles the 200-char
    // text cap, so a truncate-then-redact serializer would persist the
    // partial secret. No part of the token may survive anywhere.
    expect(body).not.toContain(straddlingToken);
    expect(body).not.toContain("ghp_abcdefghij");
    expect(body).not.toContain("github_pat_abcdefghijklmnopqrstuvwxyz1234567");
    expect(body).toContain("[redacted]");

    const first = parsed.candidates[0]!;
    expect(first.description).toBe("[redacted]");
    expect(first.topics).toContain("[redacted]");
    expect(first.sourceIds).not.toContain("github_pat_abcdefghijklmnopqrstuvwxyz1234567");
    expect(String((first.reasons as string[])[0])).toBe("[redacted]");
    const evidence = first.attentionEvidence as Array<Record<string, unknown>>;
    expect(String(evidence[0]!.title)).toHaveLength(200);
    expect(evidence[0]!.englishSummary).toBe("[redacted]");

    // The default defensive cap also applies when callers omit the cap.
    const defaultWritten = writeDiscoverySnapshot(dir, {
      ...snapshot,
      runAt: "2026-08-15T02:00:00.000Z",
      candidates: Array.from({ length: 25 }, (_, index) =>
        makeCandidate({ canonicalUrl: `https://github.com/acme/repo-${index}` })
      ),
    });
    expect(defaultWritten.ok).toBe(true);
    if (!defaultWritten.ok) throw new Error("expected snapshot write to succeed");
    const defaultParsed = JSON.parse(readFileSync(join(dir, "2026-08-15.json"), "utf8")) as {
      candidates: Array<Record<string, unknown>>;
    };
    expect(defaultParsed.candidates).toHaveLength(20);
  });
});

describe("agent-memory-trends discovery queue artifact", () => {
  function queueCounts(overrides: Partial<DiscoveryQueueCounts> = {}): DiscoveryQueueCounts {
    return {
      totalEvaluated: 1,
      queued: 1,
      suppressed: 0,
      alert: 0,
      tracked: 0,
      new: 1,
      watch: 0,
      ...overrides,
    };
  }

  it("writes a dated queue artifact with deterministic field order, counts, and warnings", () => {
    const written = writeDiscoveryQueue({
      dir,
      snapshotPath: ".skillwiki/agent-memory-trends/discovery/2026-08-14.json",
      generatedAt: "2026-08-14T02:00:00.000Z",
      maxDailyCandidates: 20,
      counts: queueCounts(),
      candidates: [makeCandidate()],
      warnings: ["collector: enrichment failed for acme/repo-a", "history: malformed snapshot 2026-08-13.json"],
    });
    expect(written.ok).toBe(true);
    if (!written.ok) throw new Error("expected queue write to succeed");
    expect(written.data.queueFile).toBe("2026-08-14-queue.json");
    expect(existsSync(join(dir, "2026-08-14-queue.json"))).toBe(true);

    const parsed = JSON.parse(readFileSync(join(dir, "2026-08-14-queue.json"), "utf8")) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual([
      "formatVersion",
      "generatedAt",
      "snapshotPath",
      "maxDailyCandidates",
      "counts",
      "candidates",
      "warnings",
    ]);
    expect(parsed.formatVersion).toBe(1);
    expect(parsed.generatedAt).toBe("2026-08-14T02:00:00.000Z");
    expect(parsed.snapshotPath).toBe(".skillwiki/agent-memory-trends/discovery/2026-08-14.json");
    expect(parsed.maxDailyCandidates).toBe(20);
    expect(parsed.warnings).toEqual([
      "collector: enrichment failed for acme/repo-a",
      "history: malformed snapshot 2026-08-13.json",
    ]);

    const candidate = (parsed.candidates as Record<string, unknown>[])[0]!;
    expect(Object.keys(candidate).sort()).toEqual([
      "alert",
      "archived",
      "attentionEvidence",
      "canonicalUrl",
      "description",
      "disposition",
      "forksCount",
      "fullName",
      "name",
      "owner",
      "promotionEligible",
      "pushedAt",
      "reasons",
      "score",
      "sourceIds",
      "stargazersCount",
      "topics",
    ]);
    expect(JSON.stringify(parsed)).not.toContain("prompt");
    expect(JSON.stringify(parsed)).not.toContain("readmeText");
    expect(JSON.stringify(parsed)).not.toContain("secret");
    expect(JSON.stringify(parsed)).not.toContain("token");
  });

  it("caps candidates at maxDailyCandidates and bounds attention evidence text", () => {
    const longEvidence = Array.from({ length: 30 }, (_, index) => ({
      sourceId: `source-${index}`,
      url: `https://example.com/item/${index}`,
      title: "t".repeat(500),
      excerpt: "e".repeat(500),
    }));
    const candidates = [
      {
        ...makeCandidate({ canonicalUrl: "https://github.com/acme/repo-a" }),
        attentionEvidence: longEvidence,
      } as unknown as DiscoveryCandidate,
      ...Array.from({ length: 24 }, (_, index) =>
        makeCandidate({ canonicalUrl: `https://github.com/acme/repo-${index}` })
      ),
    ];
    const written = writeDiscoveryQueue({
      dir,
      snapshotPath: ".skillwiki/agent-memory-trends/discovery/2026-08-14.json",
      generatedAt: "2026-08-14T02:00:00.000Z",
      maxDailyCandidates: 20,
      counts: queueCounts({ totalEvaluated: 25, queued: 20 }),
      candidates,
      warnings: [],
    });
    expect(written.ok).toBe(true);
    if (!written.ok) throw new Error("expected queue write to succeed");

    const parsed = JSON.parse(readFileSync(join(dir, "2026-08-14-queue.json"), "utf8")) as {
      candidates: Array<Record<string, unknown>>;
    };
    expect(parsed.candidates).toHaveLength(20);
    const first = parsed.candidates[0]!;
    const evidence = first.attentionEvidence as Array<Record<string, unknown>>;
    expect(evidence).toHaveLength(20);
    expect(String(evidence[0]!.title)).toHaveLength(200);
    expect(String(evidence[0]!.excerpt)).toHaveLength(200);
  });

  it("redacts token-like text from persisted fields and rejects invalid run timestamps", () => {
    const leak = "GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz123456";
    const evil = {
      ...makeCandidate({ canonicalUrl: "https://github.com/acme/repo-a" }),
      description: `repo description with ${leak}`,
    } as unknown as DiscoveryCandidate;
    const written = writeDiscoveryQueue({
      dir,
      snapshotPath: ".skillwiki/agent-memory-trends/discovery/2026-08-14.json",
      generatedAt: "2026-08-14T02:00:00.000Z",
      maxDailyCandidates: 20,
      counts: queueCounts(),
      candidates: [evil],
      warnings: [`collector: enrichment failed with ${leak}`],
    });
    expect(written.ok).toBe(true);
    if (!written.ok) throw new Error("expected queue write to succeed");

    const body = readFileSync(join(dir, "2026-08-14-queue.json"), "utf8");
    expect(body).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz123456");
    expect(body).toContain("[redacted]");

    const invalid = writeDiscoveryQueue({
      dir,
      snapshotPath: ".skillwiki/agent-memory-trends/discovery/not-a-date.json",
      generatedAt: "not-a-date",
      maxDailyCandidates: 20,
      counts: queueCounts(),
      candidates: [],
      warnings: [],
    });
    expect(invalid.ok).toBe(false);
    if (invalid.ok) throw new Error("expected invalid run time to be rejected");
    expect(invalid.error).toBe("QUEUE_INVALID");
    expect(readdirSync(dir)).not.toContain("not-a-date-queue.json");
  });

  it("never persists extra fields from a malformed candidate object", () => {
    const evil = {
      ...makeCandidate({ canonicalUrl: "https://github.com/acme/repo-a" }),
      prompt: "system: you are a research agent that creates tasks",
      readmeBody: "full README body that must never be persisted",
      environment: { AGENT_MEMORY_TRENDS_HEARTBEAT_URL: "https://secret.example/push" },
    } as unknown as DiscoveryCandidate;
    const written = writeDiscoveryQueue({
      dir,
      snapshotPath: ".skillwiki/agent-memory-trends/discovery/2026-08-14.json",
      generatedAt: "2026-08-14T02:00:00.000Z",
      maxDailyCandidates: 20,
      counts: queueCounts(),
      candidates: [evil],
      warnings: [],
    });
    expect(written.ok).toBe(true);
    if (!written.ok) throw new Error("expected queue write to succeed");

    const body = readFileSync(join(dir, "2026-08-14-queue.json"), "utf8");
    expect(body).not.toContain("system: you are a research agent");
    expect(body).not.toContain("full README body");
    expect(body).not.toContain("https://secret.example/push");
  });
});
