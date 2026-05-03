import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveInitTimePath, resolveRuntimePath } from "../../src/utils/wiki-path.js";

function newHome(): string {
  const h = mkdtempSync(join(tmpdir(), "home-"));
  mkdirSync(join(h, ".skillwiki"), { recursive: true });
  mkdirSync(join(h, ".hermes"), { recursive: true });
  return h;
}

describe("resolveInitTimePath", () => {
  it("priority: --target > env > skillwiki dotenv > hermes dotenv > $HOME/wiki", async () => {
    const home = newHome();
    writeFileSync(join(home, ".skillwiki", ".env"), "WIKI_PATH=/sw/x\n");
    writeFileSync(join(home, ".hermes", ".env"), "WIKI_PATH=/hermes/y\n");

    expect((await resolveInitTimePath({ flag: "/explicit", envValue: "/env", home })).path).toBe("/explicit");
    expect((await resolveInitTimePath({ flag: undefined, envValue: "/env", home })).path).toBe("/env");
    expect((await resolveInitTimePath({ flag: undefined, envValue: undefined, home })).path).toBe("/sw/x");
  });

  it("falls through to hermes dotenv when skillwiki dotenv is absent", async () => {
    const home = newHome();
    writeFileSync(join(home, ".hermes", ".env"), "WIKI_PATH=/hermes/y\n");
    const r = await resolveInitTimePath({ flag: undefined, envValue: undefined, home });
    expect(r.path).toBe("/hermes/y");
    expect(r.source).toBe("hermes-dotenv");
  });

  it("falls back to $HOME/wiki when no source supplies a value", async () => {
    const home = newHome();
    const r = await resolveInitTimePath({ flag: undefined, envValue: undefined, home });
    expect(r.path).toBe(join(home, "wiki"));
    expect(r.source).toBe("default");
  });

  it("source labels reflect the level that matched", async () => {
    const home = newHome();
    writeFileSync(join(home, ".skillwiki", ".env"), "WIKI_PATH=/sw/x\n");
    expect((await resolveInitTimePath({ flag: "/x", envValue: undefined, home })).source).toBe("flag");
    expect((await resolveInitTimePath({ flag: undefined, envValue: "/y", home })).source).toBe("env");
    expect((await resolveInitTimePath({ flag: undefined, envValue: undefined, home })).source).toBe("skillwiki-dotenv");
  });
});

describe("resolveRuntimePath", () => {
  it("priority: --vault > env > skillwiki dotenv (NO hermes fallback)", async () => {
    const home = newHome();
    writeFileSync(join(home, ".skillwiki", ".env"), "WIKI_PATH=/sw/x\n");
    writeFileSync(join(home, ".hermes", ".env"), "WIKI_PATH=/hermes/y\n");

    expect((await resolveRuntimePath({ flag: "/v", envValue: "/e", home })).ok).toBe(true);
    const r1 = await resolveRuntimePath({ flag: undefined, envValue: undefined, home });
    expect(r1.ok && r1.data.path).toBe("/sw/x");
    expect(r1.ok && r1.data.source).toBe("skillwiki-dotenv");
  });

  it("returns NO_VAULT_CONFIGURED error when chain misses (hermes is ignored at runtime)", async () => {
    const home = newHome();
    writeFileSync(join(home, ".hermes", ".env"), "WIKI_PATH=/hermes/y\n");
    const r = await resolveRuntimePath({ flag: undefined, envValue: undefined, home });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toBe("NO_VAULT_CONFIGURED");
  });

  it("--explain returns the chain", async () => {
    const home = newHome();
    writeFileSync(join(home, ".skillwiki", ".env"), "WIKI_PATH=/sw/x\n");
    const r = await resolveRuntimePath({ flag: undefined, envValue: undefined, home, explain: true });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(Array.isArray(r.data.chain)).toBe(true);
      expect(r.data.chain!.map(c => c.source)).toEqual(["flag", "env", "skillwiki-dotenv"]);
    }
  });
});
