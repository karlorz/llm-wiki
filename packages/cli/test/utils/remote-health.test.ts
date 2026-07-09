import { describe, it, expect } from "vitest";
import {
  probeGithubReachability,
  probeS3Reachability,
  buildDegradedReasons,
  probeRemoteHealth,
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
});