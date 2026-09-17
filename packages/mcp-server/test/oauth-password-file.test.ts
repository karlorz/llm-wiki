import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, statSync, existsSync, readdirSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import {
  readPasswordHashFile,
  writePasswordHashFile,
  OPERATOR_PASSWORD_HASH_FILENAME,
} from "../src/oauth-password-file.js";
import { hashPassword } from "../src/oauth.js";

describe("oauth-password-file", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "oauth-pw-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("exports the expected filename constant", () => {
    expect(OPERATOR_PASSWORD_HASH_FILENAME).toBe("password.hash");
  });

  it("returns undefined when password.hash is missing", () => {
    expect(readPasswordHashFile(tempDir)).toBeUndefined();
  });

  it("returns undefined when password.hash is empty or whitespace only", () => {
    const hashPath = join(tempDir, OPERATOR_PASSWORD_HASH_FILENAME);
    writeFileSync(hashPath, "");
    expect(readPasswordHashFile(tempDir)).toBeUndefined();

    writeFileSync(hashPath, "   \n\t  \n");
    expect(readPasswordHashFile(tempDir)).toBeUndefined();
  });

  it("returns trimmed password hash when file is present and non-empty", () => {
    const hash = hashPassword("operator-secret");
    const hashPath = join(tempDir, OPERATOR_PASSWORD_HASH_FILENAME);
    writeFileSync(hashPath, `  ${hash}\n`);
    expect(readPasswordHashFile(tempDir)).toBe(hash);
  });

  it("writes encoded scrypt string atomically and sets chmod 0600", () => {
    const hash = hashPassword("secret-pass");
    writePasswordHashFile(tempDir, hash);

    const hashPath = join(tempDir, OPERATOR_PASSWORD_HASH_FILENAME);
    expect(existsSync(hashPath)).toBe(true);

    const content = readPasswordHashFile(tempDir);
    expect(content).toBe(hash);

    const stats = statSync(hashPath);
    // Windows does not expose POSIX permission bits through stat.
    if (platform() !== "win32") {
      expect(stats.mode & 0o777).toBe(0o600);
    }

    // Atomic write should leave no leftover temp files in directory
    const files = readdirSync(tempDir);
    expect(files).toEqual([OPERATOR_PASSWORD_HASH_FILENAME]);
  });

  it("throws when writing invalid or non-scrypt string", () => {
    expect(() => writePasswordHashFile(tempDir, "plaintext-password")).toThrow(/scrypt/i);
    expect(() => writePasswordHashFile(tempDir, "")).toThrow();
  });

  it("creates stateDir if it does not already exist when writing", () => {
    const nestedDir = join(tempDir, "nested", "state");
    const hash = hashPassword("nested-pass");
    writePasswordHashFile(nestedDir, hash);

    const content = readPasswordHashFile(nestedDir);
    expect(content).toBe(hash);
  });
});
