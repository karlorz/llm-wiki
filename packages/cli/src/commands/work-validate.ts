import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { ok, err, ExitCode, type Result } from "@skillwiki/shared";
import { extractFrontmatter } from "../parsers/frontmatter.js";
import { scanConflictMarkerBlocksInText } from "../utils/conflict-markers.js";

export interface WorkValidateInput {
  vault: string;
  workItem: string;
  /** When true, require completed status + evidence + no unchecked steps. */
  requireComplete?: boolean;
}

export interface WorkValidateFinding {
  code: string;
  path?: string;
  message: string;
}

export interface WorkValidateOutput {
  work_item: string;
  valid: boolean;
  findings: WorkValidateFinding[];
  status?: { spec?: string; plan?: string };
  evidence_present: boolean;
  unchecked_steps: number;
  conflict_markers: number;
  decisions_present: boolean;
  pr_metadata: Record<string, unknown> | null;
  humanHint: string;
}

type Run = { exitCode: number; result: Result<WorkValidateOutput> };
type MarkdownFileRecord =
  | { file: string; text: string; frontmatter: ReturnType<typeof extractFrontmatter> }
  | { file: string; text: null; frontmatter: null };

const GOAL_PLAN_MODE_FILES = new Set(["spec.md", "plan.md", "build-report.md"]);

/** Normalize work-item paths to vault-relative POSIX form. */
export function normalizeWorkItemRel(workItem: string): string {
  return workItem.replace(/\\/g, "/").replace(/^\.?\//, "");
}

function scanFileConflicts(relPath: string, text: string): number {
  return scanConflictMarkerBlocksInText(relPath, text).length;
}

function countUnchecked(text: string): number {
  return [...text.matchAll(/^- \[ \]/gm)].length;
}

function isGoalPlanMode(value: unknown): boolean {
  return typeof value === "string" && ["goal-plan", "goal"].includes(value.trim().toLowerCase());
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isCompletedStatus(status: string | undefined): boolean {
  return status === "completed" || status === "complete" || status === "done";
}

function planClaimsCompletion(status: string | undefined, goalPlanMode: boolean): boolean {
  return goalPlanMode
    ? isCompletedStatus(status)
    : status === "completed" || status === "complete";
}

function extractPrMetadata(fm: Record<string, unknown>): Record<string, unknown> | null {
  const keys = [
    "pr_url",
    "pr_number",
    "merge_commit",
    "merged",
    "merge_method",
    "merge_auto_approved",
  ];
  const out: Record<string, unknown> = {};
  let any = false;
  for (const k of keys) {
    if (k in fm) {
      out[k] = fm[k];
      any = true;
    }
  }
  return any ? out : null;
}

function validatePrMetadata(meta: Record<string, unknown> | null, findings: WorkValidateFinding[]): void {
  if (!meta) return;
  if ("pr_number" in meta && meta.pr_number !== null && meta.pr_number !== undefined) {
    if (typeof meta.pr_number !== "number" && !/^\d+$/.test(String(meta.pr_number))) {
      findings.push({
        code: "bad_pr_metadata",
        message: `pr_number must be numeric, got ${JSON.stringify(meta.pr_number)}`,
      });
    }
  }
  if ("pr_url" in meta && meta.pr_url != null) {
    const url = String(meta.pr_url);
    if (url && !/^https?:\/\//.test(url)) {
      findings.push({
        code: "bad_pr_metadata",
        message: `pr_url must be an http(s) URL, got ${url}`,
      });
    }
  }
  if (meta.merged === true && !meta.merge_commit && !meta.pr_number && !meta.pr_url) {
    findings.push({
      code: "bad_pr_metadata",
      message: "merged: true requires merge_commit or pr_number/pr_url",
    });
  }
}

/**
 * Cross-check a work item directory: spec/plan status, evidence, decisions,
 * PR metadata, unchecked completion steps, and conflict markers.
 */
export async function runWorkValidate(input: WorkValidateInput): Promise<Run> {
  const rel = normalizeWorkItemRel(input.workItem);
  const workDir = join(input.vault, rel);
  if (!existsSync(workDir)) {
    return {
      exitCode: ExitCode.FILE_NOT_FOUND,
      result: err("FILE_NOT_FOUND", { path: rel }),
    };
  }

  const findings: WorkValidateFinding[] = [];
  const status: { spec?: string; plan?: string } = {};
  let unchecked = 0;
  let conflicts = 0;
  let decisionsPresent = false;
  let prMetadata: Record<string, unknown> | null = null;

  const files = readdirSync(workDir).filter((f) => f.endsWith(".md"));
  const markdownFiles: MarkdownFileRecord[] = files.map((file) => {
    try {
      const text = readFileSync(join(workDir, file), "utf8");
      return { file, text, frontmatter: extractFrontmatter(text) };
    } catch {
      return { file, text: null, frontmatter: null };
    }
  });
  const goalPlanMode = markdownFiles.some(
    ({ file, frontmatter }) =>
      GOAL_PLAN_MODE_FILES.has(file) && frontmatter?.ok && isGoalPlanMode(frontmatter.data.mode),
  );
  let evidencePresent =
    goalPlanMode && (files.includes("build-report.md") || isDirectory(join(workDir, "evidence")));

  if (!files.includes("spec.md") && !goalPlanMode) {
    findings.push({ code: "missing_spec", path: `${rel}/spec.md`, message: "spec.md is required" });
  }
  if (goalPlanMode && !files.includes("plan.md")) {
    findings.push({ code: "missing_plan", path: `${rel}/plan.md`, message: "goal-plan mode requires plan.md" });
  }

  for (const { file, text, frontmatter } of markdownFiles) {
    if (text === null || frontmatter === null) {
      findings.push({ code: "unreadable", path: `${rel}/${file}`, message: "cannot read file" });
      continue;
    }
    const c = scanFileConflicts(`${rel}/${file}`, text);
    conflicts += c;
    if (c > 0) {
      findings.push({
        code: "conflict_markers",
        path: `${rel}/${file}`,
        message: `${c} conflict marker block(s)`,
      });
    }
    unchecked += countUnchecked(text);

    if (frontmatter.ok) {
      if (file === "spec.md") {
        status.spec = typeof frontmatter.data.status === "string" ? frontmatter.data.status : undefined;
      }
      if (file === "plan.md") {
        status.plan = typeof frontmatter.data.status === "string" ? frontmatter.data.status : undefined;
      }
      if (file === (goalPlanMode ? "plan.md" : "spec.md")) {
        prMetadata = extractPrMetadata(frontmatter.data as Record<string, unknown>);
        validatePrMetadata(prMetadata, findings);
      }
    }
    if (file === "evidence.md" || file === "retro.md") {
      evidencePresent = true;
    }
    if (file === "decisions.md" || /##\s+Decisions/i.test(text) || /structured.decisions/i.test(text)) {
      decisionsPresent = true;
    }
    // ADR-style decision lists
    if (/^- \*\*Decision\*\*:/m.test(text) || /^## Decision/m.test(text)) {
      decisionsPresent = true;
    }
  }

  if (input.requireComplete) {
    const specSource = goalPlanMode ? "plan" : "spec";
    const specSourceStatus = goalPlanMode ? status.plan : status.spec;
    if (specSourceStatus && !isCompletedStatus(specSourceStatus)) {
      findings.push({
        code: "spec_not_completed",
        path: `${rel}/${specSource}.md`,
        message: `${specSource} status is ${specSourceStatus}, expected completed`,
      });
    }
    if (!specSourceStatus) {
      findings.push({
        code: "spec_status_missing",
        path: `${rel}/${specSource}.md`,
        message: `${specSource} frontmatter status missing for completion`,
      });
    }
    if (!evidencePresent) {
      findings.push({
        code: "missing_evidence",
        path: rel,
        message: goalPlanMode
          ? "completion requires build-report.md, evidence/, evidence.md, or retro.md"
          : "completion requires evidence.md or retro.md",
      });
    }
    if (unchecked > 0) {
      findings.push({
        code: "unchecked_steps",
        path: rel,
        message: `${unchecked} unchecked completion step(s) remain`,
      });
    }
  }

  // When plan claims completed, require evidence
  if (planClaimsCompletion(status.plan, goalPlanMode)) {
    if (!evidencePresent && !(goalPlanMode && input.requireComplete)) {
      findings.push({
        code: "missing_evidence",
        path: rel,
        message: goalPlanMode
          ? "plan is completed but build-report.md, evidence/, evidence.md, or retro.md is missing"
          : "plan is completed but evidence/retro is missing",
      });
    }
  }

  const valid = findings.length === 0;
  const hint = valid
    ? `work item valid: ${rel}`
    : `work item invalid (${findings.length}): ${findings.map((f) => f.code).join(", ")}`;

  return {
    exitCode: valid ? ExitCode.OK : ExitCode.PREFLIGHT_FAILED,
    result: ok({
      work_item: rel,
      valid,
      findings,
      status,
      evidence_present: evidencePresent,
      unchecked_steps: unchecked,
      conflict_markers: conflicts,
      decisions_present: decisionsPresent,
      pr_metadata: prMetadata,
      humanHint: hint,
    }),
  };
}
