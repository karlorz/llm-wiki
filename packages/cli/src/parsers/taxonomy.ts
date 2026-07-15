import yaml from "js-yaml";
import { ok, err, type Result, getErrorMessage } from "@skillwiki/shared";

export const TAG_SLUG_RE = /^[a-z0-9][a-z0-9_./-]*$/;

export interface TaxonomyDocument {
  tags: string[];
  yamlStart: number;
  yamlEnd: number;
  closingFenceStart: number;
  newline: "\n" | "\r\n";
  itemIndent: string;
}

export interface TaxonomyReconcileResult {
  text: string;
  requested: string[];
  existing: string[];
  missing: string[];
  added: string[];
  changed: boolean;
}

function taxonomyItemIndent(yamlText: string): string | undefined {
  const lines = yamlText.split(/\r?\n/);
  const taxonomyLine = lines.findIndex((line) => /^taxonomy:[ \t]*(?:#.*)?$/.test(line));
  if (taxonomyLine === -1) return undefined;

  for (const line of lines.slice(taxonomyLine + 1)) {
    if (/^[ \t]*(?:#.*)?$/.test(line)) continue;
    return /^([ \t]+)-[ \t]+/.exec(line)?.[1];
  }
  return undefined;
}

/**
 * Locates the fenced YAML taxonomy under the exact `## Tag Taxonomy` heading.
 * Offsets are deliberately returned so callers can splice only that block and
 * preserve all unrelated SCHEMA.md bytes (including comments and line endings).
 */
export function parseTaxonomyDocument(schemaText: string): Result<TaxonomyDocument> {
  const heading = /^##[ \t]+Tag Taxonomy[ \t]*\r?$/m.exec(schemaText);
  if (!heading || heading.index === undefined) {
    return err("NO_TAXONOMY_BLOCK", { message: "Tag Taxonomy heading not found" });
  }

  const afterHeading = heading.index + heading[0].length;
  const unboundedTail = schemaText.slice(afterHeading);
  const nextHeading = /^#{1,2}[ \t]+/m.exec(unboundedTail);
  const sectionEnd = nextHeading?.index === undefined
    ? schemaText.length
    : afterHeading + nextHeading.index;
  const sectionText = schemaText.slice(afterHeading, sectionEnd);
  const open = /^```yaml[ \t]*\r?$/m.exec(sectionText);
  if (!open || open.index === undefined) {
    return err("NO_TAXONOMY_BLOCK", { message: "Fenced YAML taxonomy block not found" });
  }

  const openStart = afterHeading + open.index;
  // The opening-fence match includes `\r` for CRLF files, so skip only the
  // remaining `\n` byte. Skipping `newline.length` here would drop the first
  // byte of YAML in a CRLF document.
  const yamlStart = openStart + open[0].length + 1;
  const afterOpen = schemaText.slice(yamlStart, sectionEnd);
  const close = /^```[ \t]*\r?$/m.exec(afterOpen);
  if (!close || close.index === undefined) {
    return err("NO_TAXONOMY_BLOCK", { message: "Taxonomy closing fence not found" });
  }

  const closingFenceStart = yamlStart + close.index;
  const newline: "\n" | "\r\n" = schemaText.slice(closingFenceStart - 2, closingFenceStart) === "\r\n"
    ? "\r\n"
    : "\n";
  const yamlEnd = closingFenceStart - newline.length;
  const yamlText = schemaText.slice(yamlStart, yamlEnd);

  let parsed: unknown;
  try {
    parsed = yaml.load(yamlText, { schema: yaml.JSON_SCHEMA });
  } catch (error: unknown) {
    return err("INVALID_FRONTMATTER", { message: getErrorMessage(error) });
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return err("INVALID_FRONTMATTER", { message: "taxonomy block is not an object" });
  }

  const tags = (parsed as Record<string, unknown>).taxonomy;
  if (!Array.isArray(tags) || !tags.every((tag) => typeof tag === "string")) {
    return err("INVALID_FRONTMATTER", { message: "taxonomy must be a list of strings" });
  }

  const itemIndent = taxonomyItemIndent(yamlText) ?? "  ";
  return ok({ tags, yamlStart, yamlEnd, closingFenceStart, newline, itemIndent });
}

/** Retains the pre-existing list-only API for current taxonomy consumers. */
export function extractTaxonomy(schemaText: string): Result<string[]> {
  const parsed = parseTaxonomyDocument(schemaText);
  if ("error" in parsed) return err(parsed.error, parsed.detail);
  return ok(parsed.data.tags);
}

function renderTag(tag: string): string {
  const roundTrip = yaml.load(`value: ${tag}\n`, { schema: yaml.JSON_SCHEMA }) as {
    value: unknown;
  };
  return typeof roundTrip.value === "string" && roundTrip.value === tag
    ? tag
    : JSON.stringify(tag);
}

/**
 * Produces the established dated reconciliation comment without deriving any
 * taxonomy terms from the page body.
 */
export function taxonomyCommentForPage(page: string, date: string, reason?: string): Result<string> {
  const cycle = /^queries\/\d{4}-\d{2}-\d{2}-research-cycle-(\d+)-report\.md$/.exec(page);
  const chosen = reason?.trim()
    || (cycle ? `research-cycle ${cycle[1]} taxonomy reconciliation` : `taxonomy reconciliation for ${page}`);
  if (!/^[A-Za-z0-9][A-Za-z0-9 ._/-]{0,159}$/.test(chosen)) {
    return err("SCHEME_REJECTED", {
      message: "reconciliation reason contains unsupported characters or is too long",
    });
  }
  return ok(`# -- added ${date}: ${chosen} --`);
}

/**
 * Adds only explicit, frontmatter-derived missing tags. It is pure and
 * idempotent: callers own locking and persistence.
 */
export function reconcileTaxonomyDocument(
  schemaText: string,
  input: { tags: readonly string[]; comment: string },
): Result<TaxonomyReconcileResult> {
  const document = parseTaxonomyDocument(schemaText);
  if ("error" in document) return err(document.error, document.detail);

  const requested = [...new Set(input.tags)].sort();
  const existingSet = new Set(document.data.tags);
  const missing = requested.filter((tag) => !existingSet.has(tag));
  const invalid = missing.filter((tag) => !TAG_SLUG_RE.test(tag));
  if (invalid.length > 0) {
    return err("SCHEME_REJECTED", { message: "invalid taxonomy tag", tags: invalid });
  }
  if (missing.length === 0) {
    return ok({
      text: schemaText,
      requested,
      existing: document.data.tags,
      missing: [],
      added: [],
      changed: false,
    });
  }

  const yamlText = schemaText.slice(document.data.yamlStart, document.data.yamlEnd);
  const itemIndent = taxonomyItemIndent(yamlText);
  if (!itemIndent) {
    return err("SCHEME_REJECTED", {
      message: "taxonomy reconciliation requires a block-style taxonomy list",
    });
  }

  const { newline, closingFenceStart } = document.data;
  const comment = `${itemIndent}${input.comment}`;
  const items = missing.map((tag) => `${itemIndent}- ${renderTag(tag)}`);
  const block = `${comment}${newline}${items.join(newline)}${newline}`;
  const text = schemaText.slice(0, closingFenceStart) + block + schemaText.slice(closingFenceStart);
  return ok({
    text,
    requested,
    existing: document.data.tags,
    missing,
    added: missing,
    changed: true,
  });
}

export interface TaxonomyConflictMergeResult {
  text: string;
  tags: string[];
  added_from_ours: string[];
  added_from_theirs: string[];
}

/** Non-taxonomy bytes outside the fenced YAML range must match base exactly. */
function taxonomyEnvelope(text: string, doc: TaxonomyDocument): string {
  return text.slice(0, doc.yamlStart) + "<taxonomy-yaml>" + text.slice(doc.closingFenceStart);
}

/**
 * Three-stage taxonomy merge: preserve base tag order, union sorted additions
 * from ours/theirs, fail closed on any byte change outside the taxonomy fence.
 */
export function mergeTaxonomyConflict(
  baseText: string,
  oursText: string,
  theirsText: string,
): Result<TaxonomyConflictMergeResult> {
  const base = parseTaxonomyDocument(baseText);
  const ours = parseTaxonomyDocument(oursText);
  const theirs = parseTaxonomyDocument(theirsText);
  if (!base.ok) return base;
  if (!ours.ok) return ours;
  if (!theirs.ok) return theirs;
  const envelope = taxonomyEnvelope(baseText, base.data);
  if (
    taxonomyEnvelope(oursText, ours.data) !== envelope ||
    taxonomyEnvelope(theirsText, theirs.data) !== envelope
  ) {
    return err("SCHEME_REJECTED", { reason: "non-taxonomy-change" });
  }
  const baseTags = new Set(base.data.tags);
  const addedFromOurs = ours.data.tags.filter((tag) => !baseTags.has(tag)).sort();
  const addedFromTheirs = theirs.data.tags.filter((tag) => !baseTags.has(tag)).sort();
  const tags = [...base.data.tags, ...new Set([...addedFromOurs, ...addedFromTheirs])];
  const rendered = reconcileTaxonomyDocument(baseText, {
    tags,
    comment: "# -- reconciled: taxonomy-only three-stage merge --",
  });
  if (!rendered.ok) return rendered;
  return ok({
    text: rendered.data.text,
    tags,
    added_from_ours: addedFromOurs,
    added_from_theirs: addedFromTheirs,
  });
}
