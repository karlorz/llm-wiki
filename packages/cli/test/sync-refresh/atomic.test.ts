import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const faults = vi.hoisted(() => ({ rename: false, link: false, sync: false }));
vi.mock("node:fs", async importOriginal => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return { ...fs,
    renameSync: (...args: Parameters<typeof fs.renameSync>) => { if (faults.rename) throw new Error("before replacement"); return fs.renameSync(...args); },
    linkSync: (...args: Parameters<typeof fs.linkSync>) => { if (faults.link) throw new Error("before creation"); return fs.linkSync(...args); },
    fsyncSync: (...args: Parameters<typeof fs.fsyncSync>) => { if (faults.sync) throw new Error("temp sync failure"); return fs.fsyncSync(...args); },
  };
});
import { materializeAdmittedPage, sha256Buffer } from "../../src/sync-refresh/materialize.js";
let base: string;
afterEach(async () => { faults.rename = faults.link = faults.sync = false; if (base) await rm(base, { recursive: true, force: true }); });
it.each(["rename", "sync"] as const)("retains old complete bytes and cleans staging after %s failure", async fault => {
  base = await realpath(await mkdtemp(join(tmpdir(), "mirror-atomic-")));
  await writeFile(join(base, ".WIKI_GIT_FROZEN"), "frozen"); await mkdir(join(base, "concepts"));
  await writeFile(join(base, "concepts/a.md"), "old complete bytes");
  faults[fault] = true;
  const result = await materializeAdmittedPage({ vault: base, rel: "concepts/a.md", body: Buffer.from("new complete bytes"), priorHash: sha256Buffer(Buffer.from("old complete bytes")) });
  expect(result.decision).toBe("denied");
  expect(await readFile(join(base, "concepts/a.md"), "utf8")).toBe("old complete bytes");
  expect(await readdir(join(base, "concepts"))).toEqual(["a.md"]);
});
it("failed exclusive publication exposes no partial create and cleans staging", async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "mirror-atomic-")));
  await writeFile(join(base, ".WIKI_GIT_FROZEN"), "frozen");
  faults.link = true;
  expect((await materializeAdmittedPage({ vault: base, rel: "raw/a.md", body: Buffer.from("complete") })).decision).toBe("denied");
  expect(await readdir(join(base, "raw"))).toEqual([]);
});
