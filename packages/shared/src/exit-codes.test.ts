import { describe, it, expect } from "vitest";
import { ExitCode, exitCodeName } from "./exit-codes.js";

describe("exit-codes", () => {
  it("declares every code from the spec Command Contracts table", () => {
    expect(ExitCode.OK).toBe(0);
    expect(ExitCode.FILE_NOT_FOUND).toBe(2);
    expect(ExitCode.MISSING_CLOSING_DELIMITER).toBe(3);
    expect(ExitCode.SCHEME_REJECTED).toBe(4);
    expect(ExitCode.HOST_BLOCKED).toBe(5);
    expect(ExitCode.MALFORMED_URL).toBe(6);
    expect(ExitCode.INVALID_FRONTMATTER).toBe(7);
    expect(ExitCode.SCHEMA_NOT_DETECTED).toBe(8);
    expect(ExitCode.VAULT_PATH_INVALID).toBe(9);
    expect(ExitCode.WRITE_FAILED).toBe(10);
    expect(ExitCode.UNRESOLVED_MARKERS).toBe(11);
    expect(ExitCode.SOURCES_INCONSISTENT).toBe(12);
    expect(ExitCode.PREFLIGHT_FAILED).toBe(13);
    expect(ExitCode.ATOMIC_COPY_FAILED).toBe(14);
  });

  it("exposes a stable name for every code (non-empty, unique)", () => {
    const codes = Object.values(ExitCode).filter(v => typeof v === "number") as number[];
    const names = codes.map(c => exitCodeName(c));
    expect(new Set(names).size).toBe(names.length);
    for (const n of names) expect(n.length).toBeGreaterThan(0);
  });
});
