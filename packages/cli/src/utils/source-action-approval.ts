import { createHash } from "node:crypto";
import { err, ok, type Result } from "@skillwiki/shared";

const VERSION = "swsrc1";

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function encodeSourceActionApproval(payload: Record<string, unknown>): string {
  const middle = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${VERSION}.${middle}.${sha256(middle)}`;
}

export function decodeSourceActionApproval(token: string): Result<Record<string, unknown>> {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== VERSION || !/^[0-9a-f]{64}$/.test(parts[2] ?? "")) {
    return err("APPROVAL_INVALID", { message: "invalid source-action approval token" });
  }
  if (sha256(parts[1]!) !== parts[2]) return err("APPROVAL_INVALID", { message: "source-action approval checksum mismatch" });
  try {
    const parsed = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return err("APPROVAL_INVALID", { message: "approval payload must be an object" });
    return ok(parsed as Record<string, unknown>);
  } catch {
    return err("APPROVAL_INVALID", { message: "source-action approval payload is invalid" });
  }
}
