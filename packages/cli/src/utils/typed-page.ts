import { lstatSync, realpathSync } from "node:fs";
import { dirname, posix, relative, resolve, sep } from "node:path";
import {
  MetaSchema,
  TypedKnowledgeSchema,
  detectSchema,
  err,
  ok,
  type Result,
} from "@skillwiki/shared";
import { extractFrontmatter } from "../parsers/frontmatter.js";
import { scanSensitiveContent } from "./sensitive-content.js";

const TYPE_DIRECTORY: Record<string, string> = {
  entity: "entities",
  concept: "concepts",
  comparison: "comparisons",
  query: "queries",
  meta: "meta",
};

export interface PreparedTypedPage {
  target: string;
  title: string;
  type: string;
  tags: string[];
  content: string;
}

/** Validate a typed page identity without consulting the filesystem. */
export function validateTypedTarget(target: string): Result<string> {
  const segments = target.split("/");
  if (
    target.length === 0 ||
    posix.isAbsolute(target) ||
    target.includes("\\") ||
    posix.normalize(target) !== target ||
    segments.some((segment) => segment === "" || segment === "." || segment === "..") ||
    !/^(entities|concepts|comparisons|queries|meta)\/[a-z0-9][a-z0-9._/-]*\.md$/.test(target)
  ) {
    return err("VAULT_PATH_INVALID", { target, message: "unsafe typed-page target" });
  }
  return ok(target);
}

export interface ResolvedTypedTarget {
  absolutePath: string;
  /** Present only when the target already exists as a non-symlink file. */
  existingRealPath?: string;
}

/**
 * Resolve a validated target while rejecting vault, parent, and target symlink
 * aliases. All filesystem failures become structured path errors so callers
 * can report them without leaking an uncaught realpath exception.
 */
export function assertTargetInsideVault(vault: string, target: string): Result<ResolvedTypedTarget> {
  const validated = validateTypedTarget(target);
  if (!validated.ok) return validated;

  let vaultReal: string;
  try {
    vaultReal = realpathSync(vault);
  } catch {
    return err("VAULT_PATH_INVALID", { target, message: "vault realpath failed" });
  }

  const absolutePath = resolve(vaultReal, target);
  const parent = dirname(absolutePath);
  let parentReal: string;
  try {
    parentReal = realpathSync(parent);
  } catch {
    return err("VAULT_PATH_INVALID", { target, message: "target parent realpath failed" });
  }

  const parentRelative = relative(vaultReal, parentReal).split(sep).join("/");
  if (parentRelative === ".." || parentRelative.startsWith("../")) {
    return err("VAULT_PATH_INVALID", { target, message: "target parent escapes vault" });
  }
  if (parentReal !== parent) {
    return err("VAULT_PATH_INVALID", { target, message: "target parent may not be a symlink alias" });
  }

  let existingRealPath: string | undefined;
  try {
    const targetStat = lstatSync(absolutePath);
    if (targetStat.isSymbolicLink()) {
      return err("VAULT_PATH_INVALID", { target, message: "target may not be a symlink" });
    }
    if (!targetStat.isFile()) {
      return err("VAULT_PATH_INVALID", { target, message: "existing target must be a regular file" });
    }
    try {
      existingRealPath = realpathSync(absolutePath);
    } catch {
      return err("VAULT_PATH_INVALID", { target, message: "target realpath failed" });
    }
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      return err("VAULT_PATH_INVALID", { target, message: "target lstat failed" });
    }
  }

  return ok({ absolutePath, existingRealPath });
}

function invalidFrontmatter(target: string, issues: Array<{ path: (string | number)[]; message: string }>) {
  return err("INVALID_FRONTMATTER", {
    target,
    errors: issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
  });
}

/**
 * Validate and describe the exact frozen page bytes that a later publisher
 * will write. This function never reads the draft path or normalizes content.
 */
export function prepareTypedPage(content: string, target: string): Result<PreparedTypedPage> {
  const safeTarget = validateTypedTarget(target);
  if (!safeTarget.ok) return safeTarget;

  const sensitive = scanSensitiveContent(content, { file: target });
  if (sensitive.length > 0) {
    return err("SENSITIVE_CONTENT_DETECTED", { file: target, findings: sensitive });
  }

  const frontmatter = extractFrontmatter(content);
  if (!frontmatter.ok) return frontmatter;

  const detected = detectSchema(frontmatter.data);
  if (detected.schema === "typed-knowledge") {
    const parsed = TypedKnowledgeSchema.safeParse(frontmatter.data);
    if (!parsed.success) return invalidFrontmatter(target, parsed.error.issues);

    const expectedDirectory = TYPE_DIRECTORY[parsed.data.type];
    if (!expectedDirectory || !target.startsWith(`${expectedDirectory}/`)) {
      return err("SCHEME_REJECTED", { target, type: parsed.data.type, message: "frontmatter type does not match target directory" });
    }
    return ok({
      target,
      title: parsed.data.title,
      type: parsed.data.type,
      tags: [...parsed.data.tags],
      content,
    });
  }

  if (detected.schema === "meta") {
    const parsed = MetaSchema.safeParse(frontmatter.data);
    if (!parsed.success) return invalidFrontmatter(target, parsed.error.issues);
    if (!target.startsWith("meta/")) {
      return err("SCHEME_REJECTED", { target, type: "meta", message: "frontmatter type does not match target directory" });
    }
    return ok({
      target,
      title: parsed.data.title,
      type: "meta",
      tags: [...parsed.data.tags],
      content,
    });
  }

  return invalidFrontmatter(target, []);
}
