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
    expect(out.live_drift.state).toBe("unknown");
    expect(out.humanHint).toMatch(/^live: /m);
    expect(out.humanHint).toMatch(/^github: /m);
    expect(out.humanHint).toMatch(/^local_git: /m);
    expect(out.humanHint).toMatch(/^live_drift: /m);
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
    expect(out.humanHint).not.toMatch(/review-required:.*review-required:/);
  });

  it("reports local dirty counts without collapsing live or GitHub", () => {
    const out = composeCopyStatus({
      live: { reachable: true },
      github: { oid: "bb26229bef6e" },
      local: {
        head: "9d95108311cc",
        behind: 12,
        blockedReason: "review-required:pull-test",
        dirty: 922,
        untracked: 902,
        detail: "dirty=922 untracked=902 live-ahead of GitHub; do not git add",
      },
    });
    expect(out.github.state).toBe("ok");
    expect(out.local_git.state).toBe("blocked");
    expect(out.local_git.dirty).toBe(922);
    expect(out.local_git.untracked).toBe(902);
    expect(out.humanHint).toContain("dirty=922");
    expect(out.humanHint).toContain("do not git add");
    expect(out.humanHint).not.toMatch(/review-required:pull-test review-required:pull-test/);
  });

  it("splits event-ledger dirty from promotable content without collapsing planes", () => {
    const out = composeCopyStatus({
      live: { reachable: true },
      github: { oid: "bb26229bef6e" },
      local: {
        head: "bb26229bef6e",
        behind: 0,
        dirty: 809,
        untracked: 809,
        ledger_untracked: 768,
        content_untracked: 41,
        detail: "event-ledger live-ahead of GitHub; do not git add",
      },
    });
    expect(out.github.state).toBe("ok");
    expect(out.local_git.state).toBe("ok");
    expect(out.local_git.ledger_untracked).toBe(768);
    expect(out.local_git.content_untracked).toBe(41);
    expect(out.humanHint).toContain("ledger_untracked=768");
    expect(out.humanHint).toContain("content_untracked=41");
    expect(out.humanHint).toContain("do not git add");
    expect(out.humanHint).not.toMatch(/dirty=809 dirty=809/);
    expect(out.humanHint).not.toMatch(/ledger_untracked=768 untracked=809/);
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
    expect(out.live_drift.state).toBe("unknown");
    expect(out.humanHint).not.toContain("stale");
  });

  it("reports authoritative live drift separately from clean projection git", () => {
    const out = composeCopyStatus({
      live: { reachable: true },
      github: { oid: "aaaaaaaaaaaa" },
      local: { head: "aaaaaaaaaaaa", behind: 0, dirty: 0, untracked: 0 },
      liveDrift: { content: 3, ledger: 768, detail: "authoritative live data ahead of GitHub" },
    });
    expect(out.local_git.state).toBe("ok");
    expect(out.local_git.content_untracked).toBeUndefined();
    expect(out.live_drift).toMatchObject({ state: "drifted", content: 3, ledger: 768 });
    expect(out.humanHint).toContain("live_drift: drifted content=3 ledger=768");
    expect(out.humanHint).not.toContain("local_git: ok ledger_untracked=768");
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
    expect(out.humanHint.split("\n")).toHaveLength(4);
    expect(out.live.state).toBe("ok");
    expect(out.github.oid).toBe("deadbeefdead");
    expect(out.local_git.state).toBe("stale");
    expect(out.live_drift.state).toBe("unknown");
  });

  it("uses the optional live-drift adapter", async () => {
    const out = await runCopyStatus({
      probeLive: () => ({ reachable: true }),
      probeGithub: () => ({ oid: "deadbeefdead" }),
      probeLocalGit: () => ({ head: "deadbeefdead", behind: 0 }),
      probeLiveDrift: () => ({ content: 1, ledger: 2 }),
    });
    expect(out.live_drift).toEqual({ state: "drifted", content: 1, ledger: 2 });
  });
});
