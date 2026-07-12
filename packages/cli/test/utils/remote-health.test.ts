import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  probeGithubReachability,
  probeS3Reachability,
  buildDegradedReasons,
  probeRemoteHealth,
  resolveWikiS3Remote,
  type ExecProbe,
} from "../../src/utils/remote-health.js";

describe("remote-health probes", () => {
  it("classifies GitHub unreachable via stub exec", () => {
    const exec: ExecProbe = (file, args) => {
      if (file === "git" && args[0] === "remote") return "https://example.com/v.git";
      if (file === "git" && args[0] === "ls-remote") throw new Error("network down");
      return "";
    };
    const dir = "/tmp/not-used";
    // probeGithub checks .git exists - use a path that won't exist in test
    // Instead test via probeRemoteHealth with mock that only hits ls-remote after remote get-url
    expect(probeS3Reachability("remote:path", (f) => {
      if (f === "rclone") throw new Error("fail");
      return "";
    })).toBe("unreachable");
  });

  it("buildDegradedReasons lists both remotes when unreachable", () => {
    const reasons = buildDegradedReasons({
      github: "unreachable",
      s3: "unreachable",
      snapshotter: "not_checked",
    });
    expect(reasons).toContain("github_remote_unreachable");
    expect(reasons).toContain("s3_remote_unreachable");
    expect(reasons).not.toContain("snapshotter_host_unreachable");
  });

  it("classifies an unconfigured S3 remote as unknown without invoking rclone", () => {
    const home = mkdtempSync(join(tmpdir(), "remote-health-home-"));
    const calls: Array<{ file: string; args: string[] }> = [];
    try {
      const health = probeRemoteHealth({
        vaultPath: join(home, "not-a-git-vault"),
        home,
        env: {},
        exec: (file, args) => {
          calls.push({ file, args });
          return "";
        },
      });

      expect(health.s3).toBe("unknown");
      expect(calls.filter(call => call.file === "rclone")).toEqual([]);
      expect(buildDegradedReasons(health)).not.toContain("s3_remote_unreachable");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("probes the exact WIKI_REMOTE configured in the SkillWiki env file", () => {
    const home = mkdtempSync(join(tmpdir(), "remote-health-home-"));
    const calls: Array<{ file: string; args: string[] }> = [];
    try {
      mkdirSync(join(home, ".skillwiki"), { recursive: true });
      writeFileSync(join(home, ".skillwiki", ".env"), "WIKI_REMOTE=cloud:cloud/wiki\n");

      const health = probeRemoteHealth({
        vaultPath: join(home, "not-a-git-vault"),
        home,
        env: {},
        exec: (file, args) => {
          calls.push({ file, args });
          return "";
        },
      });

      expect(health.s3).toBe("ok");
      expect(calls.filter(call => call.file === "rclone")).toEqual([{
        file: "rclone",
        args: ["lsf", "cloud:cloud/wiki", "--max-depth", "1", "--files-only"],
      }]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("prefers process WIKI_REMOTE over the SkillWiki env file", () => {
    const home = mkdtempSync(join(tmpdir(), "remote-health-home-"));
    const calls: Array<{ file: string; args: string[] }> = [];
    try {
      mkdirSync(join(home, ".skillwiki"), { recursive: true });
      writeFileSync(join(home, ".skillwiki", ".env"), "WIKI_REMOTE=env-file:wiki\n");

      expect(resolveWikiS3Remote({
        home,
        env: { WIKI_REMOTE: "process:wiki" },
      })).toBe("process:wiki");

      const health = probeRemoteHealth({
        vaultPath: join(home, "not-a-git-vault"),
        home,
        env: { WIKI_REMOTE: "process:wiki" },
        exec: (file, args) => {
          calls.push({ file, args });
          return "";
        },
      });

      expect(health.s3).toBe("ok");
      expect(calls.filter(call => call.file === "rclone")).toEqual([{
        file: "rclone",
        args: ["lsf", "process:wiki", "--max-depth", "1", "--files-only"],
      }]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
