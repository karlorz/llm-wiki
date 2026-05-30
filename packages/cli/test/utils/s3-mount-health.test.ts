import { describe, it, expect } from "vitest";
import { mkdtempSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extractRcloneFs,
  getRcloneArgs,
  parseRcloneFlags,
  findRcloneMountPid,
  detectFuseMount,
  getRcloneVersion,
  writeTest,
  parseDurationSeconds,
  FLAG_THRESHOLDS,
  MIN_RCLONE_VERSION,
} from "../../src/utils/s3-mount-health.js";

describe("extractRcloneFs", () => {
  it("extracts the remote fs after the mount keyword", () => {
    expect(extractRcloneFs(["mount", "cloud:cloud/wiki", "/root/wiki"])).toBe("cloud:cloud/wiki");
  });

  it("returns null when there is no mount keyword", () => {
    expect(extractRcloneFs(["sync", "cloud:bucket", "/dst"])).toBeNull();
  });

  it("skips flags and absolute paths when locating the remote", () => {
    expect(extractRcloneFs(["mount", "--vfs-cache-mode", "writes", "remote:bucket", "/mnt"])).toBe("remote:bucket");
  });

  it("returns null when mount has no remote-style arg", () => {
    expect(extractRcloneFs(["mount", "/only/local/path"])).toBeNull();
  });
});

describe("getRcloneArgs", () => {
  it("returns an empty array for a non-existent pid", () => {
    expect(getRcloneArgs(999999)).toEqual([]);
  });
});

describe("parseRcloneFlags", () => {
  it("returns an empty map for a non-existent pid", () => {
    expect(parseRcloneFlags(999999).size).toBe(0);
  });
});

describe("findRcloneMountPid", () => {
  it("returns null or a numeric pid without throwing", () => {
    const pid = findRcloneMountPid();
    expect(pid === null || typeof pid === "number").toBe(true);
  });
});

describe("detectFuseMount", () => {
  it("returns null on local disk (or a well-formed mount descriptor)", () => {
    const res = detectFuseMount(tmpdir());
    if (res !== null) {
      expect(typeof res.mountPoint).toBe("string");
      expect(typeof res.fsType).toBe("string");
    } else {
      expect(res).toBeNull();
    }
  });
});

describe("getRcloneVersion", () => {
  it("returns null when rclone is absent, or a parsed version", () => {
    const v = getRcloneVersion();
    if (v !== null) {
      expect(typeof v.major).toBe("number");
      expect(typeof v.minor).toBe("number");
      expect(typeof v.patch).toBe("number");
      expect(v.raw).toContain("rclone");
    } else {
      expect(v).toBeNull();
    }
  });
});

describe("writeTest", () => {
  it("succeeds on a writable dir and leaves no residue", () => {
    const dir = mkdtempSync(join(tmpdir(), "wt-"));
    const res = writeTest(dir);
    expect(res.success).toBe(true);
    expect(res.size).toBeGreaterThan(0);
    expect(res.writeMs).toBeGreaterThanOrEqual(0);
    expect(res.readMs).toBeGreaterThanOrEqual(0);
    // No .doctor-write-test-*.tmp left behind
    expect(readdirSync(dir).some(f => f.startsWith(".doctor-write-test-"))).toBe(false);
  });

  it("fails gracefully on a non-existent dir", () => {
    const res = writeTest("/nonexistent/path/should/not/exist");
    expect(res.success).toBe(false);
    expect(res.error).toBeTruthy();
  });
});

describe("constants", () => {
  it("FLAG_THRESHOLDS declares the three critical VFS flags", () => {
    expect(Object.keys(FLAG_THRESHOLDS).sort()).toEqual(
      ["--vfs-cache-max-age", "--vfs-write-back", "--vfs-write-wait"].sort()
    );
    for (const t of Object.values(FLAG_THRESHOLDS)) {
      expect(typeof t.min).toBe("number");
      expect(typeof t.unit).toBe("string");
      expect(typeof t.label).toBe("string");
    }
  });

  it("MIN_RCLONE_VERSION is 1.65.0", () => {
    expect(MIN_RCLONE_VERSION).toEqual({ major: 1, minor: 65, patch: 0 });
  });
});

describe("parseDurationSeconds", () => {
  it("parses plain numeric seconds", () => {
    expect(parseDurationSeconds("10")).toBe(10);
    expect(parseDurationSeconds("0.5")).toBe(0.5);
  });

  it("parses unit-suffixed durations", () => {
    expect(parseDurationSeconds("10m")).toBe(600);
    expect(parseDurationSeconds("1.5h")).toBe(5400);
    expect(parseDurationSeconds("500ms")).toBe(0.5);
  });

  it("parses compound durations", () => {
    expect(parseDurationSeconds("1h30m")).toBe(5400);
    expect(parseDurationSeconds("2m10s")).toBe(130);
  });

  it("returns null for invalid durations", () => {
    expect(parseDurationSeconds("")).toBeNull();
    expect(parseDurationSeconds("abc")).toBeNull();
    expect(parseDurationSeconds("1h30")).toBeNull();
  });
});
