import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPath } from "../../src/commands/path.js";

function home(): string {
  const h = mkdtempSync(join(tmpdir(), "home-"));
  mkdirSync(join(h, ".skillwiki"), { recursive: true });
  mkdirSync(join(h, ".hermes"), { recursive: true });
  return h;
}

describe("runPath", () => {
  it("runtime mode: returns path + source from skillwiki dotenv", async () => {
    const h = home();
    writeFileSync(join(h, ".skillwiki", ".env"), "WIKI_PATH=/sw/x\n");
    const r = await runPath({ flag: undefined, envValue: undefined, home: h, initTime: false });
    expect(r.exitCode).toBe(0);
    expect(r.result.ok).toBe(true);
    if (r.result.ok) {
      expect(r.result.data.path).toBe("/sw/x");
      expect(r.result.data.source).toBe("skillwiki-dotenv");
    }
  });

  it("runtime mode: returns NO_VAULT_CONFIGURED (exit 25) when chain misses", async () => {
    const h = home();
    const r = await runPath({ flag: undefined, envValue: undefined, home: h, initTime: false });
    expect(r.exitCode).toBe(25);
    expect(r.result.ok).toBe(false);
    if (!r.result.ok) expect(r.result.error).toBe("NO_VAULT_CONFIGURED");
  });

  it("init-time mode: always succeeds with default fallback", async () => {
    const h = home();
    const r = await runPath({ flag: undefined, envValue: undefined, home: h, initTime: true });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      expect(r.result.data.path).toBe(join(h, "wiki"));
      expect(r.result.data.source).toBe("default");
    }
  });

  it("--explain returns a chain array", async () => {
    const h = home();
    writeFileSync(join(h, ".skillwiki", ".env"), "WIKI_PATH=/sw/x\n");
    const r = await runPath({ flag: undefined, envValue: undefined, home: h, initTime: false, explain: true });
    if (r.result.ok) {
      expect(Array.isArray(r.result.data.chain)).toBe(true);
    }
  });
});
