import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { extractGitTree } from "../../src/utils/git-archive.js";

it.skipIf(process.platform !== "win32")("extracts a Unicode Git tree with Windows PowerShell and metacharacter paths", () => {
  const root = mkdtempSync(join(tmpdir(), "skillwiki-zip-"));
  try {
    const source = join(root, "source"), destination = join(root, "中文 '$() archive");
    mkdirSync(source);
    mkdirSync(destination);
    const name = "資料 '$().md", content = "# Unicode archive regression\n";
    writeFileSync(join(source, name), content);
    const git = (...args: string[]) => execFileSync("git", args, { cwd: source, stdio: "pipe" });
    git("init");
    git("config", "core.autocrlf", "false");
    git("add", "--", name);
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "fixture");
    extractGitTree(source, "HEAD", destination);
    expect(readFileSync(join(destination, name), "utf8")).toBe(content);
    expect(existsSync(`${destination}.zip`)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
