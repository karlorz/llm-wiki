import { describe, it, expect } from "vitest";
import { buildCliSurface } from "../../src/utils/cli-surface.js";

/**
 * Drift-detection test: verify that buildCliSurface() covers the known
 * set of top-level commands and subcommands.
 *
 * This catches the case where someone adds a new command to cli.ts
 * but forgets to update cli-surface.ts.
 *
 * We use a known-set approach instead of execSync on the CLI binary
 * because execSync with relative paths fails in CI (different cwd context).
 * The known set is maintained here — when a new command is added to cli.ts,
 * this test should be updated too.
 *
 * Intentionally excluded from known set: lint-internal sub-modules
 * (e.g., path-too-long, raw-body-dedup) — these are wired into the
 * lint.ts orchestrator as buckets/fix handlers, not standalone CLI
 * commands, and are NOT registered in cli.ts. They should NOT be added
 * to the knownCommands arrays below.
 */
describe("cli-surface drift detection", () => {
  it("surface includes all known top-level commands", () => {
    const surface = buildCliSurface();
    const knownCommands = [
      "hash", "fetch-guard", "validate", "graph", "canvas", "overlap",
      "query", "orphans", "audit", "install", "path", "lang", "init",
      "links", "tag-audit", "index-check", "index-link-format",
      "topic-map-check", "stale", "claim", "pagesize", "log-rotate",
      "log-append",
      "lint", "config", "health", "doctor", "status", "archive", "drift", "dedup",
      "migrate-citations", "frontmatter-fix", "update", "self-update",
      "transcripts", "project-index", "compound", "tag-sync", "sync",
      "backup", "seed", "observe", "session-brief", "ingest", "fleet",
    ];

    for (const cmd of knownCommands) {
      expect(surface.has(cmd), `missing top-level command: ${cmd}`).toBe(true);
    }
  });

  it("surface includes all known subcommands", () => {
    const surface = buildCliSurface();
    const subcommandGroups = [
      { parent: "graph", subs: ["build"] },
      { parent: "canvas", subs: ["generate"] },
      { parent: "config", subs: ["get", "set", "list", "path"] },
      { parent: "compound", subs: ["promote", "list", "delete"] },
      { parent: "sync", subs: ["status", "push", "pull"] },
      { parent: "backup", subs: ["sync", "restore"] },
      { parent: "fleet", subs: ["validate", "context"] },
    ];

    for (const group of subcommandGroups) {
      for (const sub of group.subs) {
        const key = `${group.parent}.${sub}`;
        expect(surface.has(key), `missing subcommand: ${key}`).toBe(true);
      }
    }
  });

  it("surface has no extra top-level commands beyond the known set", () => {
    const surface = buildCliSurface();
    const knownCommands = new Set([
      "hash", "fetch-guard", "validate", "graph", "canvas", "overlap",
      "query", "orphans", "audit", "install", "path", "lang", "init",
      "links", "tag-audit", "index-check", "index-link-format",
      "topic-map-check", "stale", "claim", "pagesize", "log-rotate",
      "log-append",
      "lint", "config", "health", "doctor", "status", "archive", "drift", "dedup",
      "migrate-citations", "frontmatter-fix", "update", "self-update",
      "transcripts", "project-index", "compound", "tag-sync", "sync",
      "backup", "seed", "observe", "session-brief", "ingest", "fleet",
    ]);

    const topLevelKeys = [...surface.keys()].filter(k => !k.includes("."));
    const extra = topLevelKeys.filter(k => !knownCommands.has(k));
    expect(extra, `extra commands in surface not in known set: ${extra.join(", ")}`).toEqual([]);
  });
});
