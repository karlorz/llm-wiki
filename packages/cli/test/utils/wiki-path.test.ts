import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveInitTimePath, resolveRuntimePath } from "../../src/utils/wiki-path.js";
import { isValidWikiProfileKey, isProfileKey, profileKey } from "../../src/utils/dotenv.js";

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

describe("isValidWikiProfileKey", () => {
  it("accepts WIKI_FINANCE_PATH", () => {
    expect(isValidWikiProfileKey("WIKI_FINANCE_PATH")).toBe(true);
  });
  it("accepts WIKI_CRYPTO_ALPHA_LANG", () => {
    expect(isValidWikiProfileKey("WIKI_CRYPTO_ALPHA_LANG")).toBe(true);
  });
  it("accepts WIKI_DEFAULT", () => {
    expect(isValidWikiProfileKey("WIKI_DEFAULT")).toBe(true);
  });
  it("rejects WIKI_PATH", () => {
    expect(isValidWikiProfileKey("WIKI_PATH")).toBe(false);
  });
  it("rejects WIKI_LANG", () => {
    expect(isValidWikiProfileKey("WIKI_LANG")).toBe(false);
  });
  it("rejects BOGUS", () => {
    expect(isValidWikiProfileKey("BOGUS")).toBe(false);
  });
  it("rejects WIKI__PATH (empty name)", () => {
    expect(isValidWikiProfileKey("WIKI__PATH")).toBe(false);
  });
  it("rejects name longer than 32 chars", () => {
    const longName = "WIKI_" + "A".repeat(33) + "_PATH";
    expect(isValidWikiProfileKey(longName)).toBe(false);
  });
});

describe("isProfileKey", () => {
  it("returns true for WIKI_FINANCE_PATH", () => {
    expect(isProfileKey("WIKI_FINANCE_PATH")).toBe(true);
  });
  it("returns true for WIKI_DEFAULT", () => {
    expect(isProfileKey("WIKI_DEFAULT")).toBe(true);
  });
  it("returns false for WIKI_PATH", () => {
    expect(isProfileKey("WIKI_PATH")).toBe(false);
  });
  it("returns false for WIKI_LANG", () => {
    expect(isProfileKey("WIKI_LANG")).toBe(false);
  });
});

describe("profileKey", () => {
  it("builds path key from lowercase name", () => {
    expect(profileKey("finance", "PATH")).toBe("WIKI_FINANCE_PATH");
  });
  it("builds lang key from lowercase name", () => {
    expect(profileKey("crypto-alpha", "LANG")).toBe("WIKI_CRYPTO_ALPHA_LANG");
  });
});

describe("resolveRuntimePath with profiles", () => {
  it("resolves named profile via --wiki flag", async () => {
    const home = newHome();
    writeFileSync(join(home, ".skillwiki", ".env"),
      "WIKI_PATH=/default/vault\nWIKI_FINANCE_PATH=/finance/vault\n");
    const r = await resolveRuntimePath({ flag: "/default/vault", envValue: undefined, home, wiki: "finance" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.path).toBe("/finance/vault");
  });

  it("returns UNKNOWN_WIKI_PROFILE when profile not found", async () => {
    const home = newHome();
    writeFileSync(join(home, ".skillwiki", ".env"), "WIKI_PATH=/default/vault\n");
    const r = await resolveRuntimePath({ flag: "/x", envValue: undefined, home, wiki: "nonexistent" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("UNKNOWN_WIKI_PROFILE");
  });

  it("--wiki flag takes precedence over WIKI_DEFAULT", async () => {
    const home = newHome();
    writeFileSync(join(home, ".skillwiki", ".env"),
      "WIKI_DEFAULT=finance\nWIKI_PATH=/default\nWIKI_FINANCE_PATH=/finance\nWIKI_CRYPTO_PATH=/crypto\n");
    const r = await resolveRuntimePath({ flag: "/x", envValue: undefined, home, wiki: "crypto" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.path).toBe("/crypto");
  });

  it("WIKI_DEFAULT selects profile when no --wiki flag", async () => {
    const home = newHome();
    writeFileSync(join(home, ".skillwiki", ".env"),
      "WIKI_DEFAULT=finance\nWIKI_PATH=/default\nWIKI_FINANCE_PATH=/finance\n");
    const r = await resolveRuntimePath({ flag: "/x", envValue: undefined, home });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.path).toBe("/finance");
  });

  it("WIKI_DEFAULT=unknown returns UNKNOWN_WIKI_PROFILE", async () => {
    const home = newHome();
    writeFileSync(join(home, ".skillwiki", ".env"),
      "WIKI_DEFAULT=bogus\nWIKI_PATH=/default\n");
    const r = await resolveRuntimePath({ flag: "/x", envValue: undefined, home });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("UNKNOWN_WIKI_PROFILE");
  });
});

describe("resolveRuntimePath with project-local config", () => {
  it("project-local ./skillwiki/.env overrides user-global", async () => {
    const home = newHome();
    writeFileSync(join(home, ".skillwiki", ".env"), "WIKI_PATH=/global/vault\n");
    const cwd = mkdtempSync(join(tmpdir(), "cwd-"));
    mkdirSync(join(cwd, ".skillwiki"), { recursive: true });
    writeFileSync(join(cwd, ".skillwiki", ".env"), "WIKI_PATH=/project/vault\n");
    const r = await resolveRuntimePath({ flag: undefined, envValue: undefined, home, cwd });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.path).toBe("/project/vault");
      expect(r.data.source).toBe("project-dotenv");
    }
  });

  it("--wiki flag takes precedence over project-local", async () => {
    const home = newHome();
    writeFileSync(join(home, ".skillwiki", ".env"),
      "WIKI_PATH=/global\nWIKI_FINANCE_PATH=/finance\n");
    const cwd = mkdtempSync(join(tmpdir(), "cwd-"));
    mkdirSync(join(cwd, ".skillwiki"), { recursive: true });
    writeFileSync(join(cwd, ".skillwiki", ".env"), "WIKI_PATH=/project\n");
    const r = await resolveRuntimePath({ flag: undefined, envValue: undefined, home, cwd, wiki: "finance" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.path).toBe("/finance");
  });
});

describe("resolveInitTimePath with project-local config", () => {
  it("project-local overrides default ~/wiki fallback", async () => {
    const home = newHome();
    const cwd = mkdtempSync(join(tmpdir(), "cwd-"));
    mkdirSync(join(cwd, ".skillwiki"), { recursive: true });
    writeFileSync(join(cwd, ".skillwiki", ".env"), "WIKI_PATH=/project/vault\n");
    const r = await resolveInitTimePath({ flag: undefined, envValue: undefined, home, cwd });
    expect(r.path).toBe("/project/vault");
    expect(r.source).toBe("project-dotenv");
  });
});
