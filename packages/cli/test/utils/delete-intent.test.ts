import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  pathToIntentFilename,
  buildDeleteIntent,
  isActiveDeleteIntent,
  writeDeleteIntent,
  listActiveDeleteIntentPaths,
  normalizeVaultRelPath,
} from "../../src/utils/delete-intent.js";

describe("delete-intent", () => {
  it("maps vault path to filename", () => {
    expect(pathToIntentFilename("summaries/foo.md")).toBe("summaries__foo.md.json");
  });

  it("rejects path escape", () => {
    expect(() => pathToIntentFilename("../outside.md")).toThrow(/invalid vault-relative path/);
    expect(() => normalizeVaultRelPath("..")).toThrow();
  });

  it("treats null expires as active", () => {
    const intent = buildDeleteIntent({
      path: "a.md",
      action: "remove",
      host: "macos-dev",
      actor: "test",
      source: "cli",
    });
    expect(isActiveDeleteIntent(intent, new Date("2026-07-14T00:00:00Z"))).toBe(true);
  });

  it("treats past expires as inactive", () => {
    const intent = buildDeleteIntent({
      path: "a.md",
      action: "remove",
      host: "macos-dev",
      actor: "test",
      source: "cli",
      expires: "2020-01-01T00:00:00.000Z",
    });
    expect(isActiveDeleteIntent(intent, new Date("2026-07-14T00:00:00Z"))).toBe(false);
  });

  it("writes and lists active intents", async () => {
    const vault = mkdtempSync(join(tmpdir(), "delete-intent-"));
    const intent = buildDeleteIntent({
      path: "summaries/x.md",
      action: "remove",
      host: "macos-dev",
      actor: "test",
      source: "cli",
    });
    const rel = await writeDeleteIntent(vault, intent);
    expect(rel).toBe("meta/delete-intents/summaries__x.md.json");
    const paths = await listActiveDeleteIntentPaths(vault);
    expect(paths).toEqual(["summaries/x.md"]);
  });
});
