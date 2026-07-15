import { createHash } from "node:crypto";

/** Deterministic SHA-256 operation identity (64 lowercase hex). */
export function operationId(namespace: string, parts: readonly string[]): string {
  const hash = createHash("sha256").update(namespace).update("\0");
  for (const part of parts) hash.update(part).update("\0");
  return hash.digest("hex");
}
