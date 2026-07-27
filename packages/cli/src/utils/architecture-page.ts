/**
 * Architecture-page target validation for project-page publish.
 *
 * Targets live under projects/{slug}/architecture/*.md and reuse typed-knowledge
 * frontmatter (type: concept) without broadening ordinary typed-page destinations.
 */
import { lstatSync, realpathSync } from "node:fs";
import { dirname, posix, relative, resolve, sep } from "node:path";
import {
  TypedKnowledgeSchema,
  detectSchema,
  err,
  ok,
  type Result,
} from "@skillwiki/shared";
import { extractFrontmatter } from "../parsers/frontmatter.js";
import { scanSensitiveContent } from "./sensitive-content.js";

export interface PreparedArchitecturePage {
  target: string;
  project: string;
  title: string;
  type: "concept";
  tags: string[];
  content: string;
  isNew: boolean;
}

export interface ResolvedArchitectureTarget {
  absolutePath: string;
  /** Present only when the target already exists as a non-symlink file. */
  existingRealPath?: string;
}

const PROJECT_SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;
const ARCH_TARGET_RE =
  /^projects\/([a-z0-9][a-z0-9-]*)\/architecture\/([a-z0-9][a-z0-9._-]*\.md)$/;

function invalidFrontmatter(target: string, issues: Array<{ path: (string | number)[]; message: string }>) {
  return err("INVALID_FRONTMATTER", {
    target,
    errors: issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
  });
}

/** Validate project slug shape used by architecture publishers. */
export function validateProjectSlug(slug: string): Result<string> {
  if (!PROJECT_SLUG_RE.test(slug)) {
    return err("VAULT_PATH_INVALID", { project: slug, message: "invalid project slug" });
  }
  return ok(slug);
}

/**
 * Validate vault-relative architecture target path.
 * Exact shape: projects/{slug}/architecture/{filename}.md
 * Rejects absolute paths, nesting, traversal, and non-markdown extensions.
 */
export function validateArchitectureTarget(target: string, project: string): Result<string> {
  const slug = validateProjectSlug(project);
  if (!slug.ok) return slug;

  if (
    target.length === 0 ||
    posix.isAbsolute(target) ||
    target.includes("\\") ||
    posix.normalize(target) !== target ||
    target.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    return err("VAULT_PATH_INVALID", { target, message: "unsafe architecture target" });
  }

  const match = ARCH_TARGET_RE.exec(target);
  if (!match) {
    return err("VAULT_PATH_INVALID", {
      target,
      message: "target must be projects/{slug}/architecture/{filename}.md",
    });
  }
  if (match[1] !== project) {
    return err("VAULT_PATH_INVALID", {
      target,
      project,
      message: "project slug does not match architecture target path",
    });
  }
  return ok(target);
}

/**
 * Resolve a validated architecture target while rejecting vault, parent, and
 * target symlink aliases.
 */
export function assertArchitectureTargetInsideVault(
  vault: string,
  target: string,
  project: string,
): Result<ResolvedArchitectureTarget> {
  const validated = validateArchitectureTarget(target, project);
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

function provenanceIncludesProject(
  provenanceProjects: string[] | undefined,
  project: string,
): boolean {
  if (!provenanceProjects) return false;
  const wanted = `[[${project}]]`;
  return provenanceProjects.some((entry) => entry === wanted || entry === project);
}

/**
 * Validate and describe frozen architecture page bytes for later publication.
 * Never reads the draft path or rewrites content.
 *
 * Rules:
 * - typed-knowledge schema with type: concept
 * - provenance: project | mixed
 * - provenance_projects includes the target project
 * - newly created pages require the `adr` tag
 * - existing legacy pages may update without forced `adr` migration
 */
export function prepareArchitecturePage(
  content: string,
  target: string,
  project: string,
  opts: { isNew: boolean } = { isNew: true },
): Result<PreparedArchitecturePage> {
  const safeTarget = validateArchitectureTarget(target, project);
  if (!safeTarget.ok) return safeTarget;

  const sensitive = scanSensitiveContent(content, { file: target });
  if (sensitive.length > 0) {
    return err("SENSITIVE_CONTENT_DETECTED", { file: target, findings: sensitive });
  }

  const frontmatter = extractFrontmatter(content);
  if (!frontmatter.ok) return frontmatter;

  const detected = detectSchema(frontmatter.data);
  if (detected.schema !== "typed-knowledge") {
    return err("SCHEME_REJECTED", {
      target,
      message: "architecture pages must use typed-knowledge frontmatter",
    });
  }

  const parsed = TypedKnowledgeSchema.safeParse(frontmatter.data);
  if (!parsed.success) return invalidFrontmatter(target, parsed.error.issues);

  if (parsed.data.type !== "concept") {
    return err("SCHEME_REJECTED", {
      target,
      type: parsed.data.type,
      message: "architecture pages require type: concept",
    });
  }

  const provenance = parsed.data.provenance;
  if (provenance !== "project" && provenance !== "mixed") {
    return err("SCHEME_REJECTED", {
      target,
      provenance,
      message: "architecture pages require provenance: project or mixed",
    });
  }

  if (!provenanceIncludesProject(parsed.data.provenance_projects, project)) {
    return err("SCHEME_REJECTED", {
      target,
      project,
      message: "provenance_projects must include the target project",
    });
  }

  const tags = [...parsed.data.tags];
  if (opts.isNew && !tags.includes("adr")) {
    return err("SCHEME_REJECTED", {
      target,
      message: "newly created architecture pages require the adr tag",
    });
  }

  return ok({
    target,
    project,
    title: parsed.data.title,
    type: "concept",
    tags,
    content,
    isNew: opts.isNew,
  });
}
