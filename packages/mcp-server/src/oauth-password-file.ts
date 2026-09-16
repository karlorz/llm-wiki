import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";

export const OPERATOR_PASSWORD_HASH_FILENAME = "password.hash";

/**
 * Validates that an encoded hash follows the expected scrypt format:
 * scrypt$<N>$<r>$<p>$<salt>$urlsafe$<hash>
 */
export function isValidPasswordHashFormat(hash: string): boolean {
  const trimmed = hash.trim();
  const parts = trimmed.split("$");
  return parts.length === 7 && parts[0] === "scrypt" && parts[5] === "urlsafe";
}

/**
 * Reads {stateDir}/password.hash when present and non-empty.
 * Returns the trimmed hash string, or undefined if absent or empty.
 */
export function readPasswordHashFile(stateDir: string): string | undefined {
  const filePath = join(stateDir, OPERATOR_PASSWORD_HASH_FILENAME);
  if (!existsSync(filePath)) {
    return undefined;
  }
  try {
    const content = readFileSync(filePath, "utf8").trim();
    if (content.length === 0) {
      return undefined;
    }
    return content;
  } catch {
    return undefined;
  }
}

/**
 * Writes an encoded scrypt string to {stateDir}/password.hash.
 * Uses atomic same-directory temp write + rename + chmod 0600.
 */
export function writePasswordHashFile(stateDir: string, encodedHash: string): void {
  const trimmed = encodedHash.trim();
  if (!isValidPasswordHashFormat(trimmed)) {
    throw new Error("Invalid password hash format: expected encoded scrypt string");
  }

  mkdirSync(stateDir, { recursive: true });

  const targetPath = join(stateDir, OPERATOR_PASSWORD_HASH_FILENAME);
  const tempPath = join(stateDir, `${OPERATOR_PASSWORD_HASH_FILENAME}.${randomBytes(8).toString("hex")}.tmp`);

  writeFileSync(tempPath, `${trimmed}\n`, { mode: 0o600 });
  try {
    chmodSync(tempPath, 0o600);
  } catch {
    // ignore on systems where chmod may not be supported
  }

  renameSync(tempPath, targetPath);

  try {
    chmodSync(targetPath, 0o600);
  } catch {
    // ignore
  }
}
