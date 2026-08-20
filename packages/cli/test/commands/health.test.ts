import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { runHealth } from "../../src/commands/health.js";
import { VAULT_SYNC_FILTER_REQUIRED_EXCLUDES } from "../../src/utils/vault-hygiene-ignores.js";

const SCHEMA = `# Vault Schema

## Tag Taxonomy

\`\`\`yaml
taxonomy:
  - model
\`\`\`
`;

const FM = (tags: string[]) => `---
title: t
type: concept
tags: [${tags.join(", ")}]
sources: []
provenance: research
created: 2026-05-03
updated: 2026-05-03
---

`;

function makeHome(): string {
  const h = mkdtempSync(join(tmpdir(), "home-"));
  mkdirSync(join(h, ".skillwiki"), { recursive: true });
  mkdirSync(join(h, ".claude", "skills", "example"), { recursive: true });
  writeFileSync(join(h, ".claude", "skills", "example", "SKILL.md"), "# Example\n");
  return h;
}

function makeVault(): string {
  const v = mkdtempSync(join(tmpdir(), "health-vault-"));
  writeFileSync(join(v, "SCHEMA.md"), SCHEMA);
  writeFileSync(join(v, "index.md"), "# Index\n\n## Concepts\n");
  writeFileSync(join(v, "log.md"), "# Vault Log\n");
  for (const d of ["entities", "concepts", "comparisons", "queries", "meta", "raw", "raw/articles"]) {
    mkdirSync(join(v, d), { recursive: true });
  }
  return v;
}

describe("runHealth", () => {
  it("composes doctor, lint, vault-sync, query readiness, and risk flags into a bounded report", async () => {
    const home = makeHome();
    const vault = makeVault();
    writeFileSync(join(home, ".skillwiki", ".env"), `WIKI_PATH=${vault}\n`);
    writeFileSync(join(vault, "concepts", "bad-tag.md"), FM(["rogue"]) + "## Overview\n\nBad tag page [[bad-tag]].\n\n## Related\n\n- [[bad-tag]]\n");
    writeFileSync(join(vault, "concepts", "bad-source.md"), FM(["model"]).replace("sources: []", "sources: [raw/articles/missing.md]") + "## Overview\n\nBad source page [[bad-source]].\n\n## Related\n\n- [[bad-source]]\n");
    writeFileSync(join(vault, "index.md"), "# Index\n\n## Concepts\n- [[bad-tag]]\n- [[bad-source]]\n");

    const r = await runHealth({
      vault,
      home,
      envValue: undefined,
      argv: ["node", "skillwiki", "health"],
      currentVersion: "0.8.5-test",
      sync: "optional",
      noFail: false,
    });

    expect(r.exitCode).toBe(23);
    expect(r.result.ok).toBe(true);
    if (r.result.ok) {
      const data = r.result.data;
      expect(data.schema_version).toBe(1);
      expect(data.vault.path).toBe(vault);
      expect(data.components.doctor).toBeDefined();
      expect(data.components.lint.status).toBe("error");
      expect(data.components.vault_sync.status).toBe("pass");
      expect(data.components.vault_sync.blocking).toBe(false);
      expect(data.components.vault_sync.installed).toBe(false);
      expect(data.components.vault_sync.summary.skipped).toBeGreaterThan(0);
      expect(data.components.vault_sync.checks[0]?.detail).toContain("optional");
      expect(data.components.query_readiness.status).toBe("error");
      expect(data.details_included).toBe(false);
      expect(data.truncated).toBe(false);
      expect(data.mutated).toBe(false);
      expect(data.report_complete).toBe(true);
      expect(data.self_check.status).toBe("pass");
      expect(data.coverage.lint.state).toBe("checked");
      expect(data.coverage.vault_sync.state).toBe("skipped");
      const errorKinds = data.components.lint.buckets.filter(b => b.severity === "error").map(b => b.kind);
      expect(errorKinds).toContain("tag_not_in_taxonomy");
      expect(errorKinds).toContain("broken_sources");
      const errorTotal = data.components.lint.buckets
        .filter(b => b.severity === "error")
        .reduce((n, b) => n + b.count, 0);
      expect(errorTotal).toBe(data.components.lint.summary.errors);
      expect(data.risk_flags.map(f => f.id)).toContain("content_integrity_risk");
      expect(data.risk_flags.map(f => f.id)).toContain("retrieval_quality_risk");
    }
  });

  it("writes an explicit report file without marking vault knowledge mutated", async () => {
    const home = makeHome();
    const vault = makeVault();
    const out = join(tmpdir(), `skillwiki-health-${Date.now()}.json`);

    const r = await runHealth({
      vault,
      home,
      envValue: undefined,
      argv: ["node", "skillwiki", "health"],
      currentVersion: "0.8.5-test",
      sync: "off",
      noFail: true,
      out,
    });

    expect(r.exitCode).toBe(0);
    expect(existsSync(out)).toBe(true);
    expect(r.result.ok).toBe(true);
    if (r.result.ok) {
      expect(r.result.data.report_written).toBe(true);
      expect(r.result.data.report_path).toBe(out);
      expect(r.result.data.mutated).toBe(false);
      const written = JSON.parse(readFileSync(out, "utf8"));
      expect(written.ok).toBe(true);
      expect(written.data.schema_version).toBe(1);
      expect(written.data.report_written).toBe(true);
    }
  });

  it("reports pending source lifecycle counts without changing health exit status", async () => {
    const home = makeHome();
    const vault = makeVault();
    const baseline = await runHealth({
      vault,
      home,
      envValue: undefined,
      argv: ["node", "skillwiki", "health"],
      currentVersion: "0.10.22-test",
      sync: "off",
      noFail: false,
    });
    // Use a relative date so the fixture stays within the 7-day "fresh" window
    // regardless of when the suite runs (absolute dates go stale and fail CI).
    const pendingDate = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    writeFileSync(join(vault, "raw", "articles", `${pendingDate}-pending.md`), `---
title: Pending
source_url: https://example.com/pending
ingested: ${pendingDate}
ingested_by: manual
---
Body
`);
    const result = await runHealth({
      vault,
      home,
      envValue: undefined,
      argv: ["node", "skillwiki", "health"],
      currentVersion: "0.10.22-test",
      sync: "off",
      noFail: false,
    });
    expect(result.exitCode).toBe(baseline.exitCode);
    if (!result.result.ok) throw new Error("health failed");
    expect(result.result.data.components.source_lifecycle).toMatchObject({
      status: "info",
      blocking: false,
      summary: { pending: 1, fresh_pending_examples: [`raw/articles/${pendingDate}-pending.md`] },
    });
    expect(result.result.data.coverage.source_lifecycle.state).toBe("checked");
    expect(result.result.data.risk_flags.some(flag => flag.id.includes("pending"))).toBe(false);
  });

  it("uses the latest OK push line when trailing JSON is appended to wiki-push.log", async () => {
    const home = makeHome();
    const vault = makeVault();
    writeFileSync(join(home, ".skillwiki", ".env"), `WIKI_PATH=${vault}\n`);

    const isMac = platform() === "darwin";
    const binDir = isMac
      ? join(home, "Library", "Application Support", "vault-sync", "bin")
      : join(home, ".local", "share", "vault-sync", "bin");
    const logDir = isMac
      ? join(home, "Library", "Logs")
      : join(home, ".local", "state", "vault-sync", "log");

    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(binDir, "wiki-push.sh"), "#!/bin/sh\n");
    if (isMac) {
      mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true });
      writeFileSync(join(home, "Library", "LaunchAgents", "com.karlchow.wiki-push.plist"), "<plist/>");
      writeFileSync(join(home, "Library", "LaunchAgents", "com.karlchow.wiki-fetch.plist"), "<plist/>");
    } else {
      mkdirSync(join(home, ".config", "systemd", "user"), { recursive: true });
      writeFileSync(join(home, ".config", "systemd", "user", "wiki-push.timer"), "[Timer]\n");
      writeFileSync(join(home, ".config", "systemd", "user", "wiki-fetch.timer"), "[Timer]\n");
      writeFileSync(join(home, ".config", "systemd", "user", "wiki-fuse-refresh.timer"), "[Timer]\n");
      writeFileSync(join(home, ".config", "systemd", "user", "wiki-fuse-refresh.service"), "[Service]\n");
    }
    mkdirSync(logDir, { recursive: true });
    const ts = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    writeFileSync(
      join(logDir, "wiki-push.log"),
      [
        `${ts} OK push (no changes) duration=61s`,
        `${ts} GIT commit created`,
        `${ts} OK git push succeeded`,
        "{\"ok\":true,\"data\":{\"vault\":{\"path\":\"/tmp/wiki\",\"source\":\"flag\"},\"summary\":{\"errors\":0,\"warnings\":0,\"info\":0},\"by_severity\":{\"error\":[],\"warning\":[],\"info\":[]}}}",
      ].join("\n"),
    );
    writeFileSync(
      join(logDir, "wiki-fetch.log"),
      `${ts} OK behind=0 delta=0 (no notify)\n`,
    );
    mkdirSync(join(home, ".config", "rclone"), { recursive: true });
    writeFileSync(
      join(home, ".config", "rclone", "wiki-push-filters.txt"),
      VAULT_SYNC_FILTER_REQUIRED_EXCLUDES.join("\n"),
    );

    const r = await runHealth({
      vault,
      home,
      envValue: undefined,
      argv: ["node", "skillwiki", "health"],
      currentVersion: "0.8.5-test",
      sync: "optional",
      noFail: true,
    });

    expect(r.result.ok).toBe(true);
    if (r.result.ok) {
      const pushCheck = r.result.data.components.vault_sync.checks.find(check => check.id === "vault_sync_last_push_age");
      expect(pushCheck?.status).toBe("pass");
      expect(pushCheck?.detail).toContain("OK push (no changes)");
    }
  });

  it("classifies push log as error when explicit FAIL timestamped line is present even if trailing JSON exists", async () => {
    const home = makeHome();
    const vault = makeVault();
    const isMac = process.platform === "darwin";
    const binDir = isMac
      ? join(home, "Library", "Application Support", "vault-sync", "bin")
      : join(home, ".local", "share", "vault-sync", "bin");
    const logDir = isMac
      ? join(home, "Library", "Logs")
      : join(home, ".local", "state", "vault-sync", "log");

    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(binDir, "wiki-push.sh"), "#!/bin/sh\n");
    if (isMac) {
      mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true });
      writeFileSync(join(home, "Library", "LaunchAgents", "com.karlchow.wiki-push.plist"), "<plist/>");
      writeFileSync(join(home, "Library", "LaunchAgents", "com.karlchow.wiki-fetch.plist"), "<plist/>");
    } else {
      mkdirSync(join(home, ".config", "systemd", "user"), { recursive: true });
      writeFileSync(join(home, ".config", "systemd", "user", "wiki-push.timer"), "[Timer]\n");
      writeFileSync(join(home, ".config", "systemd", "user", "wiki-fetch.timer"), "[Timer]\n");
      writeFileSync(join(home, ".config", "systemd", "user", "wiki-fuse-refresh.timer"), "[Timer]\n");
      writeFileSync(join(home, ".config", "systemd", "user", "wiki-fuse-refresh.service"), "[Service]\n");
    }
    mkdirSync(logDir, { recursive: true });
    const ts = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    writeFileSync(
      join(logDir, "wiki-push.log"),
      [
        `${ts} FAIL rclone copy failed exit=1`,
        '{"status":"failed","reason":"LINT_DELTA_FULL_FAILED","errors":0}',
      ].join("\n"),
    );
    writeFileSync(
      join(logDir, "wiki-fetch.log"),
      `${ts} OK behind=0 delta=0 (no notify)\n`,
    );
    mkdirSync(join(home, ".config", "rclone"), { recursive: true });
    writeFileSync(
      join(home, ".config", "rclone", "wiki-push-filters.txt"),
      VAULT_SYNC_FILTER_REQUIRED_EXCLUDES.join("\n"),
    );

    const r = await runHealth({
      vault,
      home,
      envValue: undefined,
      argv: ["node", "skillwiki", "health"],
      currentVersion: "0.8.5-test",
      sync: "optional",
      noFail: true,
    });

    expect(r.result.ok).toBe(true);
    if (r.result.ok) {
      const pushCheck = r.result.data.components.vault_sync.checks.find(check => check.id === "vault_sync_last_push_age");
      expect(pushCheck?.status).toBe("error");
      expect(pushCheck?.detail).toContain("FAIL");
    }
  });

  it("classifies fetch log as error when a timestamped ERROR line follows an older OK line (skeptic finding on #56)", async () => {
    const home = makeHome();
    const vault = makeVault();
    const isMac = process.platform === "darwin";
    const binDir = isMac
      ? join(home, "Library", "Application Support", "vault-sync", "bin")
      : join(home, ".local", "share", "vault-sync", "bin");
    const logDir = isMac
      ? join(home, "Library", "Logs")
      : join(home, ".local", "state", "vault-sync", "log");

    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(binDir, "wiki-push.sh"), "#!/bin/sh\n");
    if (isMac) {
      mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true });
      writeFileSync(join(home, "Library", "LaunchAgents", "com.karlchow.wiki-push.plist"), "<plist/>");
      writeFileSync(join(home, "Library", "LaunchAgents", "com.karlchow.wiki-fetch.plist"), "<plist/>");
    } else {
      mkdirSync(join(home, ".config", "systemd", "user"), { recursive: true });
      writeFileSync(join(home, ".config", "systemd", "user", "wiki-push.timer"), "[Timer]\n");
      writeFileSync(join(home, ".config", "systemd", "user", "wiki-fetch.timer"), "[Timer]\n");
      writeFileSync(join(home, ".config", "systemd", "user", "wiki-fuse-refresh.timer"), "[Timer]\n");
      writeFileSync(join(home, ".config", "systemd", "user", "wiki-fuse-refresh.service"), "[Service]\n");
    }
    mkdirSync(logDir, { recursive: true });
    const older = new Date(Date.now() - 3600_000).toISOString().replace(/\.\d{3}Z$/, "Z");
    const newer = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    // Old OK fetch, then a recent timestamped ERROR failure (wiki-fetch-notify.sh shape).
    writeFileSync(
      join(logDir, "wiki-fetch.log"),
      [`${older} OK behind=0 delta=0 (no notify)`, `${newer} ERROR: /vault is not a git repo`].join("\n"),
    );
    writeFileSync(
      join(logDir, "wiki-push.log"),
      `${older} OK push (no changes) duration=61s\n`,
    );
    mkdirSync(join(home, ".config", "rclone"), { recursive: true });
    writeFileSync(
      join(home, ".config", "rclone", "wiki-push-filters.txt"),
      VAULT_SYNC_FILTER_REQUIRED_EXCLUDES.join("\n"),
    );

    const r = await runHealth({
      vault,
      home,
      envValue: undefined,
      argv: ["node", "skillwiki", "health"],
      currentVersion: "0.8.5-test",
      sync: "optional",
      noFail: true,
    });

    expect(r.result.ok).toBe(true);
    if (r.result.ok) {
      const fetchCheck = r.result.data.components.vault_sync.checks.find(check => check.id === "vault_sync_last_fetch_status");
      expect(fetchCheck?.status).toBe("error");
      expect(fetchCheck?.detail).toContain("ERROR");
    }
  });
});
