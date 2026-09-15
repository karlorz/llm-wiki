import { describe, expect, it } from "vitest";
import { composeCopyStatus, runCopyStatus } from "../../src/copy-status/copy-status.js";

describe("composeCopyStatus", () => {
  it("names all three planes even when local git looks healthy", () => {
    const out = composeCopyStatus({
      live: { reachable: true, detail: "S3 reachable" },
      github: { oid: "bb26229bef6e" },
      local: { head: "bb26229bef6e", behind: 0 },
    });
    expect(out.live.state).toBe("ok");
    expect(out.github.state).toBe("ok");
    expect(out.local_git.state).toBe("ok");
    expect(out.humanHint).toMatch(/^live: /m);
    expect(out.humanHint).toMatch(/^github: /m);
    expect(out.humanHint).toMatch(/^local_git: /m);
    expect(out.humanHint).not.toMatch(/^git log/i);
  });

  it("does not treat review-required skip as GitHub death", () => {
    const out = composeCopyStatus({
      live: { reachable: true },
      github: { oid: "bb26229bef6e" },
      local: {
        head: "9d95108311cc",
        behind: 12,
        blockedReason: "review-required:pull-KarldeMac-mini-20260914T044456Z-47706-82ac1787",
      },
    });
    expect(out.github.state).toBe("ok");
    expect(out.local_git.state).toBe("blocked");
    expect(out.local_git.blocked_reason).toContain("review-required:");
    expect(out.local_git.behind).toBe(12);
    expect(out.humanHint).toContain("github: ok");
    expect(out.humanHint).toContain("local_git: blocked");
  });

  it("keeps unknown distinct from stale", () => {
    const out = composeCopyStatus({
      live: { unknown: true },
      github: { unknown: true },
      local: { unknown: true },
    });
    expect(out.live.state).toBe("unknown");
    expect(out.github.state).toBe("unknown");
    expect(out.local_git.state).toBe("unknown");
    expect(out.humanHint).not.toContain("stale");
  });

  it("marks local_git stale when behind GitHub without a journal block", () => {
    const out = composeCopyStatus({
      live: { reachable: true },
      github: { oid: "aaaaaaaaaaaa" },
      local: { head: "bbbbbbbbbbbb", behind: 3 },
    });
    expect(out.local_git.state).toBe("stale");
    expect(out.github.state).toBe("ok");
  });
});

describe("runCopyStatus", () => {
  it("uses injected adapters and never collapses planes", async () => {
    const out = await runCopyStatus({
      probeLive: () => ({ reachable: true }),
      probeGithub: () => ({ oid: "deadbeefdead" }),
      probeLocalGit: () => ({ head: "cafebabecafe", behind: 1 }),
    });
    expect(out.humanHint.split("\n")).toHaveLength(3);
    expect(out.live.state).toBe("ok");
    expect(out.github.oid).toBe("deadbeefdead");
    expect(out.local_git.state).toBe("stale");
  });
});
