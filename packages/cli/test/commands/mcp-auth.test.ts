import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ExitCode } from "@skillwiki/shared";
import { runMcpAuthIssueHost } from "../../src/commands/mcp-auth.js";
import { parseMcpTokenMap } from "../../src/utils/mcp-token-map.js";

const plantedRng = () => Buffer.alloc(32, 7);
const plantedRaw = Buffer.alloc(32, 7).toString("base64url");
const plantedHash = createHash("sha256").update(plantedRaw, "utf8").digest("hex");

function mapDir(): { dir: string; mapPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "mcp-auth-"));
  return { dir, mapPath: join(dir, "token-map.yaml") };
}

describe("runMcpAuthIssueHost", () => {
  it("refuses --write without a TTY and does not print the secret", async () => {
    const { mapPath } = mapDir();
    writeFileSync(mapPath, "");
    const stderr: string[] = [];
    const r = await runMcpAuthIssueHost({
      hostId: "sg03",
      mapPath,
      write: true,
      isTty: false,
      rng: plantedRng,
      stderrWrite: (s) => {
        stderr.push(s);
      },
    });
    expect(r.exitCode).toBe(ExitCode.PREFLIGHT_FAILED);
    expect(r.result.ok).toBe(false);
    if (!r.result.ok) expect(r.result.error).toBe("NO_TTY");
    expect(stderr.join("")).not.toContain(plantedRaw);
  });

  it("dry-run validates without writing or printing a secret", async () => {
    const { mapPath } = mapDir();
    const existing = `${"a".repeat(64)}: macos-dev\n`;
    writeFileSync(mapPath, existing);
    const stderr: string[] = [];
    const r = await runMcpAuthIssueHost({
      hostId: "sg03",
      mapPath,
      write: false,
      isTty: true,
      rng: plantedRng,
      stderrWrite: (s) => {
        stderr.push(s);
      },
    });
    expect(r.exitCode).toBe(ExitCode.OK);
    expect(r.result.ok).toBe(true);
    if (r.result.ok) {
      expect(r.result.data.wrote).toBe(false);
      expect(r.result.data.host_id).toBe("sg03");
      expect(r.result.data.map_path).toBe(mapPath);
    }
    expect(readFileSync(mapPath, "utf8")).toBe(existing);
    expect(stderr.join("")).not.toContain(plantedRaw);
  });

  it("write appends a hash, prints raw once on stderr, and keeps JSON secret-free", async () => {
    const { mapPath } = mapDir();
    const existingHash = "a".repeat(64);
    writeFileSync(mapPath, `${existingHash}: macos-dev\n`);
    const stderr: string[] = [];
    const r = await runMcpAuthIssueHost({
      hostId: "sg03",
      mapPath,
      write: true,
      isTty: true,
      rng: plantedRng,
      stderrWrite: (s) => {
        stderr.push(s);
      },
    });
    expect(r.exitCode).toBe(ExitCode.OK);
    expect(r.result.ok).toBe(true);
    if (r.result.ok) {
      expect(r.result.data.wrote).toBe(true);
      expect(r.result.data.hash_prefix).toMatch(/^[0-9a-f]{8}$/);
      expect(r.result.data.hash_prefix).toBe(plantedHash.slice(0, 8));
      expect(r.result.data.host_id).toBe("sg03");
      expect(Object.keys(r.result.data).sort()).toEqual(["hash_prefix", "host_id", "map_path", "wrote"]);
    }
    const encoded = JSON.stringify(r);
    expect(encoded).not.toContain("raw");
    expect(encoded).not.toContain(plantedRaw);
    expect(encoded).not.toContain(plantedHash);
    expect(stderr).toHaveLength(1);
    expect(stderr[0]).toContain(plantedRaw);
    expect(stderr[0]).toContain("copy once");
    const map = parseMcpTokenMap(readFileSync(mapPath, "utf8"));
    expect(map.get(existingHash)).toBe("macos-dev");
    expect(map.get(plantedHash)).toBe("sg03");
  });

  it("duplicate host-id with --write leaves the file unchanged", async () => {
    const { mapPath } = mapDir();
    const body = `${"a".repeat(64)}: macos-dev\n`;
    writeFileSync(mapPath, body);
    const r = await runMcpAuthIssueHost({
      hostId: "macos-dev",
      mapPath,
      write: true,
      isTty: true,
      rng: plantedRng,
      stderrWrite: () => {},
    });
    expect(r.exitCode).toBe(ExitCode.PREFLIGHT_FAILED);
    expect(r.result.ok).toBe(false);
    if (!r.result.ok) expect(r.result.error).toBe("DUPLICATE_HOST_ID");
    expect(readFileSync(mapPath, "utf8")).toBe(body);
  });

  it("missing map file with --write creates a one-row map in an existing dir", async () => {
    const { mapPath } = mapDir();
    expect(existsSync(mapPath)).toBe(false);
    const r = await runMcpAuthIssueHost({
      hostId: "sg03",
      mapPath,
      write: true,
      isTty: true,
      rng: plantedRng,
      stderrWrite: () => {},
    });
    expect(r.exitCode).toBe(ExitCode.OK);
    expect(r.result.ok).toBe(true);
    if (r.result.ok) expect(r.result.data.wrote).toBe(true);
    const map = parseMcpTokenMap(readFileSync(mapPath, "utf8"));
    expect(map.get(plantedHash)).toBe("sg03");
    expect(map.size).toBe(1);
  });
});
