import { describe, expect, it } from "vitest";
import { APPROVED_JOB_ORDER, parseMaintenanceConfig } from "../src/config.js";

const FLEET = `schema_version: 1
vault_remote: git@github.com:karlorz/wiki.git
s3_remote: seaweed-wiki:cloud/wiki
hosts:
  sg01:
    class: prod-linux
    role: snapshotter
    writes_to: [github]
    protected: true
    identity:
      hostnames: [sg01]
  sg02:
    class: dev-linux
    role: leaf
    writes_to: [github]
    protected: false
    identity:
      hostnames: [sg02]
      public_addresses: [161.118.233.237]
    access:
      from:
        macos-dev:
          status: configured
          ssh_aliases: [sg02, cloudsg02, sg02-agent, sg02-agent-memory]
          users: [root, agent, agent-memory]
          transports: [public-ip]
    maintenance:
      skillwiki_satellite:
        enabled: true
        user: agent-memory
        vault_path: /home/agent-memory/wiki
        repo_path: /home/agent-memory/llm-wiki
        ssh_alias: sg02-agent-memory
        scheduler: systemd
        timezone: Asia/Hong_Kong
        jobs:
          - self-update-check
          - vault-sync-preflight
          - agent-memory-trends-daily
          - session-brief-refresh
          - health-summary
        cadence:
          self_update_check: every-4-hours
          daily_window: "00:10 Asia/Hong_Kong"
`;

describe("parseMaintenanceConfig", () => {
  it("reads the approved sg02 satellite configuration from fleet metadata", () => {
    const parsed = parseMaintenanceConfig(FLEET, "sg02", "fleet.yaml");

    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.data.hostId).toBe("sg02");
      expect(parsed.data.user).toBe("agent-memory");
      expect(parsed.data.sshAlias).toBe("sg02-agent-memory");
      expect(parsed.data.vaultPath).toBe("/home/agent-memory/wiki");
      expect(parsed.data.repoPath).toBe("/home/agent-memory/llm-wiki");
      expect(parsed.data.protectedHost).toBe(false);
      expect(parsed.data.scheduler).toBe("systemd");
      expect(parsed.data.jobs).toEqual(APPROVED_JOB_ORDER);
      expect(parsed.data.cadence.selfUpdateCheck).toEqual({ everyHours: 4 });
      expect(parsed.data.cadence.dailyWindow).toEqual({ time: "00:10", timezone: "Asia/Hong_Kong" });
    }
  });

  it("rejects a satellite config that does not list exactly the approved v1 jobs", () => {
    const parsed = parseMaintenanceConfig(FLEET.replace("          - health-summary\n", ""), "sg02", "fleet.yaml");

    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error).toBe("CONFIG_INVALID");
      expect(String(parsed.detail)).toContain("approved Stage 1 job order");
    }
  });
});
