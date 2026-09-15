import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveConfiguredFetchProjection } from "../../src/utils/fetch-projection.js";

function makeHome(config: string): string {
  const home = mkdtempSync(join(tmpdir(), "fetch-projection-"));
  mkdirSync(join(home, ".skillwiki"), { recursive: true });
  writeFileSync(join(home, ".skillwiki", ".env"), config);
  return home;
}

describe("resolveConfiguredFetchProjection", () => {
  it("returns the configured absolute projection path", () => {
    const home = makeHome("vault_sync.fetch_projection=/var/lib/wiki-fetch\n");
    expect(resolveConfiguredFetchProjection(home)).toBe("/var/lib/wiki-fetch");
  });

  it("treats none and a missing key as unconfigured", () => {
    expect(resolveConfiguredFetchProjection(makeHome("vault_sync.fetch_projection=none\n"))).toBeUndefined();
    expect(resolveConfiguredFetchProjection(makeHome("vault_sync.role=leaf\n"))).toBeUndefined();
  });

  it("does not fall back to the protected snapshot worktree", () => {
    const home = makeHome("vault_sync.snapshot_worktree=/root/wiki-git\n");
    expect(resolveConfiguredFetchProjection(home)).toBeUndefined();
  });

  it("fails closed for a raw relative projection value", () => {
    const home = makeHome("vault_sync.fetch_projection=wiki-fetch\n");
    expect(resolveConfiguredFetchProjection(home)).toBeUndefined();
  });
});
