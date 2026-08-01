import { err, ok, type Result } from "@skillwiki/shared";
import { posix } from "node:path";

export type RawOperationClass = "create" | "read" | "preserve-move" | "rewrite" | "destructive-remove";
export type RawTriggerClass = "report-only" | "attended-apply" | "policy-gated-background-apply";
export type RawPreserveOperation = "rename" | "relocate" | "archive" | "deduplicate";

export interface RawPathInfo {
  path: string;
  category: "articles" | "papers" | "transcripts" | "assets";
  storage: "active" | "archived" | "duplicate" | "asset";
  relativeWithinCategory: string;
}

const SOURCE_CATEGORIES = new Set(["articles", "papers", "transcripts"]);

export function classifyRawPath(value: string): Result<RawPathInfo> {
  const path = value.replaceAll("\\", "/");
  if (path !== posix.normalize(path) || path.startsWith("/") || path.includes("\0") || path.split("/").includes("..")) {
    return err("RAW_PATH_INVALID", { path: value });
  }
  const parts = path.split("/");
  if (parts[0] !== "raw") return err("RAW_PATH_OUTSIDE_LAYER", { path });
  if (parts[1] === "assets" && parts.length > 2) {
    return ok({ path, category: "assets", storage: "asset", relativeWithinCategory: parts.slice(2).join("/") });
  }
  if ((parts[1] === "archived" || parts[1] === "duplicates") && SOURCE_CATEGORIES.has(parts[2] ?? "") && parts.length > 3) {
    return ok({
      path,
      category: parts[2] as RawPathInfo["category"],
      storage: parts[1] === "archived" ? "archived" : "duplicate",
      relativeWithinCategory: parts.slice(3).join("/"),
    });
  }
  if (SOURCE_CATEGORIES.has(parts[1] ?? "") && parts.length > 2) {
    return ok({
      path,
      category: parts[1] as RawPathInfo["category"],
      storage: "active",
      relativeWithinCategory: parts.slice(2).join("/"),
    });
  }
  return err("RAW_PATH_UNSUPPORTED", { path });
}

export function lifecycleDestination(source: string, operation: RawPreserveOperation): Result<string> {
  const parsed = classifyRawPath(source);
  if (!parsed.ok) return parsed;
  if (parsed.data.category === "assets") {
    return err("RAW_ASSET_PATH_FROZEN", { path: source, message: "asset lifecycle is logical by default" });
  }
  if (parsed.data.storage !== "active") return err("RAW_SOURCE_NOT_ACTIVE", { path: source, storage: parsed.data.storage });
  if (operation === "archive") return ok(`raw/archived/${parsed.data.category}/${parsed.data.relativeWithinCategory}`);
  if (operation === "deduplicate") return ok(`raw/duplicates/${parsed.data.category}/${parsed.data.relativeWithinCategory}`);
  return ok(source);
}

export function authorizeRawOperation(input: {
  operationClass: RawOperationClass;
  trigger: RawTriggerClass;
  source?: string;
  destination?: string;
  explicitExactTarget?: boolean;
}): Result<true> {
  if (input.operationClass === "read") return ok(true);
  if (input.operationClass === "rewrite") return err("RAW_REWRITE_FORBIDDEN", { source: input.source });
  if (input.operationClass === "destructive-remove") {
    return input.trigger === "attended-apply" && input.explicitExactTarget === true
      ? ok(true)
      : err("RAW_DISPOSAL_REQUIRES_EXACT_TARGET_APPROVAL", { source: input.source });
  }
  if (input.operationClass === "preserve-move") {
    if (input.trigger === "report-only") return err("RAW_STRUCTURAL_REPORT_ONLY", { source: input.source, destination: input.destination });
    if (!input.source || !input.destination) return err("RAW_PATH_INVALID", { source: input.source, destination: input.destination });
    const source = classifyRawPath(input.source);
    if (!source.ok) return source;
    const destination = classifyRawPath(input.destination);
    if (!destination.ok) return destination;
    return ok(true);
  }
  return ok(true);
}
