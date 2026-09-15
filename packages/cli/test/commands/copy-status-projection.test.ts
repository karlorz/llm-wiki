import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultCopyStatusDeps, runCopyStatusCommand } from "../../src/commands/copy-status.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

function projectionFixture(): { home: string; live: string; projection: string; head: string } {
  const root = mkdtempSync(join(tmpdir(), "copy-status-projection-"));
  const home = join(root, "home");
  const live = join(root, "wiki");
  const source = join(root, "source");
  const origin = join(root, "origin.git");
  const projection = join(root, "wiki-fetch");
  mkdirSync(join(home, ".skillwiki"), { recursive: true });
  mkdirSync(source, { recursive: true });
  git(source, "init", "-b", "main");
  git(source, "config", "user.name", "test");
  git(source, "config", "user.email", "test@example.com");
  writeFileSync(join(source, "SCHEMA.md"), "# schema\n");
  git(source, "add", "SCHEMA.md");
  git(source, "commit", "-m", "init");
  execFileSync("git", ["clone", "--bare", source, origin]);
  execFileSync("git", ["clone", origin, live]);
  execFileSync("git", ["clone", origin, projection]);
  const head = git(live, "rev-parse", "HEAD");
  writeFileSync(join(home, ".skillwiki", ".env"), `vault_sync.fetch_projection=${projection}\n`);
  return { home, live, projection, head };
}

describe("defaultCopyStatusDeps fetch projection", () => {
  it("uses live Git planes and visibly ignores a configured sibling projection", async () => {
    const fixture = projectionFixture();
    writeFileSync(join(fixture.projection, "projection-only.md"), "projection\n");
    git(fixture.projection, "add", "projection-only.md");
    git(fixture.projection, "-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-m", "projection only");
    git(fixture.projection, "remote", "set-url", "origin", join(fixture.home, "missing-origin.git"));

    const output = await runCopyStatusCommand({ vault: fixture.live, home: fixture.home, s3Ok: true });

    expect(output.result).toMatchObject({
      ok: true,
      data: {
        github: { oid: fixture.head },
        local_git: { oid: fixture.head, behind: 0 },
      },
    });
    if (output.result.ok) {
      expect(output.result.data.humanHint).toContain("configured fetch projection ignored");
      expect(output.result.data.humanHint).toContain("using live vault");
    }
  });

  it("reports ignored live-ledger inventory when ordinary Git dirt is zero", () => {
    const fixture = projectionFixture();
    writeFileSync(join(fixture.home, ".skillwiki", ".env"), "vault_sync.fetch_projection=none\n");
    writeFileSync(join(fixture.live, ".git", "info", "exclude"), "meta/log-events/\n");
    const eventDir = join(fixture.live, "meta", "log-events", "2026-09-16");
    mkdirSync(eventDir, { recursive: true });
    writeFileSync(join(eventDir, `${"9".repeat(64)}.json`), "{}\n");

    const deps = defaultCopyStatusDeps({ vault: fixture.live, home: fixture.home, s3Ok: true });

    expect(deps.probeLocalGit()).toMatchObject({
      head: fixture.head,
      dirty: 0,
      untracked: 0,
      ledger_untracked: 1,
    });
  });

  it("uses live Git planes without a projection warning when the key is absent", async () => {
    const fixture = projectionFixture();
    writeFileSync(join(fixture.home, ".skillwiki", ".env"), "WIKI_PATH=/unused\n");

    const deps = defaultCopyStatusDeps({ vault: fixture.live, home: fixture.home, s3Ok: true });

    const github = await deps.probeGithub();
    expect(github).toMatchObject({ oid: fixture.head });
    const local = await deps.probeLocalGit();
    expect(local).toMatchObject({ head: fixture.head, behind: 0 });
    expect(local.detail ?? "").not.toContain("fetch projection");
  });

  it("uses live Git planes with a warning when an explicit projection is missing", () => {
    const fixture = projectionFixture();
    writeFileSync(
      join(fixture.home, ".skillwiki", ".env"),
      `vault_sync.fetch_projection=${join(fixture.home, "missing")}\n`,
    );
    const deps = defaultCopyStatusDeps({ vault: fixture.live, home: fixture.home, s3Ok: true });
    expect(deps.probeGithub()).toMatchObject({ oid: fixture.head });
    expect(deps.probeLocalGit()).toMatchObject({
      head: fixture.head,
      detail: expect.stringContaining("configured fetch projection ignored"),
    });
  });

  it("uses live Git planes with a warning when the configured projection is the live vault", () => {
    const fixture = projectionFixture();
    writeFileSync(
      join(fixture.home, ".skillwiki", ".env"),
      `vault_sync.fetch_projection=${fixture.live}\n`,
    );
    const deps = defaultCopyStatusDeps({ vault: fixture.live, home: fixture.home, s3Ok: true });
    expect(deps.probeGithub()).toMatchObject({ oid: fixture.head });
    expect(deps.probeLocalGit()).toMatchObject({
      head: fixture.head,
      detail: expect.stringContaining("configured fetch projection ignored"),
    });
  });

  it("uses live Git planes with a warning for an explicit relative projection value", () => {
    const fixture = projectionFixture();
    writeFileSync(join(fixture.home, ".skillwiki", ".env"), "vault_sync.fetch_projection=wiki-fetch\n");
    const deps = defaultCopyStatusDeps({ vault: fixture.live, home: fixture.home, s3Ok: true });
    expect(deps.probeGithub()).toMatchObject({ oid: fixture.head });
    expect(deps.probeLocalGit()).toMatchObject({
      head: fixture.head,
      detail: expect.stringContaining("configured fetch projection ignored"),
    });
  });

  it("uses live Git planes with a warning when the configured projection is nested with the live vault", () => {
    const fixture = projectionFixture();
    const nested = join(fixture.live, "fetch");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(fixture.home, ".skillwiki", ".env"), `vault_sync.fetch_projection=${nested}\n`);

    const deps = defaultCopyStatusDeps({ vault: fixture.live, home: fixture.home, s3Ok: true });

    expect(deps.probeGithub()).toMatchObject({ oid: fixture.head });
    expect(deps.probeLocalGit()).toMatchObject({
      head: fixture.head,
      detail: expect.stringContaining("configured fetch projection ignored"),
    });
  });

  it("measures live Markdown and ledger drift without attributing it to projection git", async () => {
    const fixture = projectionFixture();
    mkdirSync(join(fixture.live, "concepts"), { recursive: true });
    writeFileSync(join(fixture.live, "concepts", "new.md"), "# live only\n");
    const eventDir = join(fixture.live, "meta", "log-events", "2026-09-15");
    mkdirSync(eventDir, { recursive: true });
    writeFileSync(
      join(eventDir, "1111111111111111111111111111111111111111111111111111111111111111.json"),
      JSON.stringify({
        schema: "skillwiki-log-event/v1",
        operation_id: "1111111111111111111111111111111111111111111111111111111111111111",
        occurred_at: "2026-09-15T00:00:00.000Z",
        host_id: "test-host",
        actor: "test",
        kind: "append",
        target: "log.md",
        note: "entry",
        metadata: {},
      }) + "\n",
    );

    const deps = defaultCopyStatusDeps({ vault: fixture.live, home: fixture.home, s3Ok: true });
    await expect(deps.probeLiveDrift?.()).resolves.toMatchObject({ content: 1, ledger: 1 });
    expect(deps.probeLocalGit()).toMatchObject({
      dirty: 2,
      untracked: 2,
      ledger_untracked: 1,
      content_untracked: 1,
      detail: expect.stringContaining("configured fetch projection ignored"),
    });
  });

  it("compares live bytes to projection HEAD rather than projection working-tree edits", async () => {
    const fixture = projectionFixture();
    writeFileSync(join(fixture.projection, "SCHEMA.md"), "# manual projection edit\n");
    const deps = defaultCopyStatusDeps({ vault: fixture.live, home: fixture.home, s3Ok: true });
    await expect(deps.probeLiveDrift?.()).resolves.toMatchObject({ content: 0, ledger: 0 });
    expect(deps.probeLocalGit()).toMatchObject({
      dirty: 0,
      detail: expect.stringContaining("configured fetch projection ignored"),
    });
  });

  it("treats matching nested Markdown in projection HEAD as synchronized", async () => {
    const fixture = projectionFixture();
    mkdirSync(join(fixture.live, "concepts"), { recursive: true });
    mkdirSync(join(fixture.projection, "concepts"), { recursive: true });
    writeFileSync(join(fixture.live, "concepts", "shared.md"), "# shared\n");
    writeFileSync(join(fixture.projection, "concepts", "shared.md"), "# shared\n");
    execFileSync("git", ["add", "concepts/shared.md"], { cwd: fixture.projection });
    execFileSync("git", ["commit", "-m", "nested"], { cwd: fixture.projection });

    const deps = defaultCopyStatusDeps({ vault: fixture.live, home: fixture.home, s3Ok: true });

    await expect(deps.probeLiveDrift?.()).resolves.toMatchObject({ content: 0, ledger: 0 });
  });

  it("reports projection HEAD Markdown missing from the authoritative live vault", async () => {
    const fixture = projectionFixture();
    mkdirSync(join(fixture.projection, "concepts"), { recursive: true });
    writeFileSync(join(fixture.projection, "concepts", "removed-live.md"), "# projection only\n");
    execFileSync("git", ["add", "concepts/removed-live.md"], { cwd: fixture.projection });
    execFileSync("git", ["commit", "-m", "projection-only"], { cwd: fixture.projection });

    const deps = defaultCopyStatusDeps({ vault: fixture.live, home: fixture.home, s3Ok: true });

    await expect(deps.probeLiveDrift?.()).resolves.toMatchObject({ content: 1, ledger: 0 });
  });

  it("does not report snapshot-non-promotable Markdown as live content drift", async () => {
    const fixture = projectionFixture();
    mkdirSync(join(fixture.live, ".drafts"), { recursive: true });
    writeFileSync(join(fixture.live, ".drafts", "private.md"), "# local draft\n");

    const deps = defaultCopyStatusDeps({ vault: fixture.live, home: fixture.home, s3Ok: true });

    await expect(deps.probeLiveDrift?.()).resolves.toMatchObject({ content: 0, ledger: 0 });
  });
});
