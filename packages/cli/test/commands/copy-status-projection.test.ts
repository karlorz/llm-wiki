import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultCopyStatusDeps } from "../../src/commands/copy-status.js";

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
  mkdirSync(live, { recursive: true });
  mkdirSync(source, { recursive: true });
  writeFileSync(join(live, "SCHEMA.md"), "# schema\n");
  git(source, "init", "-b", "main");
  git(source, "config", "user.name", "test");
  git(source, "config", "user.email", "test@example.com");
  writeFileSync(join(source, "SCHEMA.md"), "# schema\n");
  git(source, "add", "SCHEMA.md");
  git(source, "commit", "-m", "init");
  execFileSync("git", ["clone", "--bare", source, origin]);
  execFileSync("git", ["clone", origin, projection]);
  const head = git(projection, "rev-parse", "HEAD");
  writeFileSync(join(home, ".skillwiki", ".env"), `vault_sync.fetch_projection=${projection}\n`);
  return { home, live, projection, head };
}

describe("defaultCopyStatusDeps fetch projection", () => {
  it("uses the configured projection when the live vault is not a git repository", () => {
    const fixture = projectionFixture();
    const deps = defaultCopyStatusDeps({ vault: fixture.live, home: fixture.home, s3Ok: true });
    expect(deps.probeGithub()).toMatchObject({ oid: fixture.head });
    expect(deps.probeLocalGit()).toMatchObject({ head: fixture.head, behind: 0 });
  });

  it("fails the git planes closed when an explicit projection is missing", () => {
    const fixture = projectionFixture();
    writeFileSync(
      join(fixture.home, ".skillwiki", ".env"),
      `vault_sync.fetch_projection=${join(fixture.home, "missing")}\n`,
    );
    const deps = defaultCopyStatusDeps({ vault: fixture.live, home: fixture.home, s3Ok: true });
    expect(deps.probeGithub()).toMatchObject({ unknown: true, detail: "configured fetch projection is not a git repository" });
    expect(deps.probeLocalGit()).toMatchObject({ unknown: true, detail: "configured fetch projection is not a git repository" });
  });

  it("fails the git planes closed when the configured projection is the live vault", () => {
    const fixture = projectionFixture();
    writeFileSync(
      join(fixture.home, ".skillwiki", ".env"),
      `vault_sync.fetch_projection=${fixture.live}\n`,
    );
    const deps = defaultCopyStatusDeps({ vault: fixture.live, home: fixture.home, s3Ok: true });
    expect(deps.probeGithub()).toMatchObject({ unknown: true, detail: "configured fetch projection must be distinct from live vault" });
    expect(deps.probeLocalGit()).toMatchObject({ unknown: true, detail: "configured fetch projection must be distinct from live vault" });
  });

  it("fails the git planes closed for an explicit relative projection value", () => {
    const fixture = projectionFixture();
    writeFileSync(join(fixture.home, ".skillwiki", ".env"), "vault_sync.fetch_projection=wiki-fetch\n");
    const deps = defaultCopyStatusDeps({ vault: fixture.live, home: fixture.home, s3Ok: true });
    expect(deps.probeGithub()).toMatchObject({ unknown: true, detail: "configured fetch projection path must be absolute" });
    expect(deps.probeLocalGit()).toMatchObject({ unknown: true, detail: "configured fetch projection path must be absolute" });
  });

  it("fails the git planes closed when the configured projection is nested with the live vault", () => {
    const fixture = projectionFixture();
    const nested = join(fixture.live, "fetch");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(fixture.home, ".skillwiki", ".env"), `vault_sync.fetch_projection=${nested}\n`);

    const deps = defaultCopyStatusDeps({ vault: fixture.live, home: fixture.home, s3Ok: true });

    expect(deps.probeGithub()).toMatchObject({
      unknown: true,
      detail: "configured fetch projection and live vault must not be nested",
    });
    expect(deps.probeLocalGit()).toMatchObject({
      unknown: true,
      detail: "configured fetch projection and live vault must not be nested",
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
    expect(deps.probeLocalGit()).toMatchObject({ dirty: 0, untracked: 0 });
  });

  it("compares live bytes to projection HEAD rather than projection working-tree edits", async () => {
    const fixture = projectionFixture();
    writeFileSync(join(fixture.projection, "SCHEMA.md"), "# manual projection edit\n");
    const deps = defaultCopyStatusDeps({ vault: fixture.live, home: fixture.home, s3Ok: true });
    await expect(deps.probeLiveDrift?.()).resolves.toMatchObject({ content: 0, ledger: 0 });
    expect(deps.probeLocalGit()).toMatchObject({ dirty: 1 });
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
