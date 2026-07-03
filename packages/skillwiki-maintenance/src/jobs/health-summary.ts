import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { err, ok, type CommandRunner, type JobCheck, type Result } from "../types.js";

export interface HealthSummaryInput {
  vaultPath: string;
  repoPath: string;
  runCommand: CommandRunner;
}

type HealthStatus = "pass" | "info" | "warn" | "error" | "unknown";

export interface HealthSummaryDetails {
  overallStatus?: HealthStatus;
  blockingStatus?: HealthStatus;
  advisoryStatus?: HealthStatus;
  riskFlags: Array<{ id: string; status: HealthStatus; blocking: boolean }>;
  warnings: Array<{ id: string; message: string }>;
  humanHint?: string;
  commandStdout?: string;
  commandStderr?: string;
  error?: string;
}

interface ParsedHealthReport {
  overallStatus: HealthStatus;
  blockingStatus: HealthStatus;
  advisoryStatus: HealthStatus;
  riskFlags: Array<{ id: string; status: HealthStatus; blocking: boolean }>;
  warnings: Array<{ id: string; message: string }>;
  humanHint: string;
}

export async function runHealthSummary(input: HealthSummaryInput): Promise<JobCheck<HealthSummaryDetails>> {
  const reportDir = mkdtempSync(join(tmpdir(), "skillwiki-maintenance-health-"));
  const reportPath = join(reportDir, "health.json");

  try {
    const result = await input.runCommand(
      "skillwiki",
      ["health", input.vaultPath, "--sync", "optional", "--no-fail", "--out", reportPath],
      { cwd: input.repoPath }
    );

    if (result.exitCode !== 0) {
      return fail(`health command failed: ${firstLine(result.stderr || result.stdout)}`, {
        riskFlags: [],
        warnings: [],
        commandStdout: result.stdout,
        commandStderr: result.stderr,
      });
    }

    const parsed = parseHealthEnvelope(readFileSync(reportPath, "utf8"));
    if (!parsed.ok) {
      return fail("health report output invalid", {
        riskFlags: [],
        warnings: [],
        error: parsed.detail instanceof Error ? parsed.detail.message : String(parsed.detail),
      });
    }

    if (!parsed.data.ok) {
      return fail(`health report failed: ${parsed.data.error}`, {
        riskFlags: [],
        warnings: [],
        error: typeof parsed.data.detail === "string" ? parsed.data.detail : JSON.stringify(parsed.data.detail),
      });
    }

    const report = parsed.data.data;
    return {
      job: "health-summary",
      status: mapHealthReportStatus(report),
      reason: summarize(report),
      details: {
        overallStatus: report.overallStatus,
        blockingStatus: report.blockingStatus,
        advisoryStatus: report.advisoryStatus,
        riskFlags: report.riskFlags,
        warnings: report.warnings,
        humanHint: report.humanHint,
      },
    };
  } catch (error) {
    return fail("health report output invalid", {
      riskFlags: [],
      warnings: [],
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    rmSync(reportDir, { recursive: true, force: true });
  }
}

function parseHealthEnvelope(text: string): Result<{ ok: true; data: ParsedHealthReport } | { ok: false; error: string; detail?: unknown }> {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!isRecord(parsed) || typeof parsed.ok !== "boolean") {
      return err("HEALTH_OUTPUT_INVALID", "health output must be a JSON envelope with an ok field");
    }

    if (parsed.ok === false) {
      return ok({
        ok: false,
        error: typeof parsed.error === "string" ? parsed.error : "HEALTH_OUTPUT_INVALID",
        detail: parsed.detail,
      });
    }

    const report = parseHealthReport(parsed.data);
    if (!report.ok) return report;
    return ok({ ok: true, data: report.data });
  } catch (error) {
    return err("HEALTH_OUTPUT_INVALID", error instanceof Error ? error : new Error(String(error)));
  }
}

function parseHealthReport(value: unknown): Result<ParsedHealthReport> {
  if (!isRecord(value)) return err("HEALTH_OUTPUT_INVALID", "health data must be an object");
  const overallStatus = asHealthStatus(value.overall_status);
  const blockingStatus = asHealthStatus(value.blocking_status);
  const advisoryStatus = asHealthStatus(value.advisory_status);
  if (!overallStatus || !blockingStatus || !advisoryStatus) {
    return err("HEALTH_OUTPUT_INVALID", "health data is missing one or more status fields");
  }

  return ok({
    overallStatus,
    blockingStatus,
    advisoryStatus,
    riskFlags: parseRiskFlags(value.risk_flags),
    warnings: parseWarnings(value.warnings),
    humanHint: typeof value.humanHint === "string" ? value.humanHint : "",
  });
}

function parseRiskFlags(value: unknown): ParsedHealthReport["riskFlags"] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isRecord(item)) return [];
    const status = asHealthStatus(item.status);
    if (!status || typeof item.id !== "string" || typeof item.blocking !== "boolean") return [];
    return [{ id: item.id, status, blocking: item.blocking }];
  });
}

function parseWarnings(value: unknown): ParsedHealthReport["warnings"] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isRecord(item) || typeof item.id !== "string" || typeof item.message !== "string") return [];
    return [{ id: item.id, message: item.message }];
  });
}

function asHealthStatus(value: unknown): HealthStatus | undefined {
  return value === "pass" || value === "info" || value === "warn" || value === "error" || value === "unknown"
    ? value
    : undefined;
}

function mapHealthStatus(status: HealthStatus): "pass" | "warn" | "fail" {
  if (status === "warn") return "warn";
  if (status === "error" || status === "unknown") return "fail";
  return "pass";
}

function mapHealthReportStatus(report: ParsedHealthReport): "pass" | "warn" | "fail" {
  if (report.overallStatus === "unknown") return "fail";

  const blocking = mapHealthStatus(report.blockingStatus);
  if (blocking === "fail") return "fail";
  if (blocking === "warn") return "warn";

  const advisory = mapHealthStatus(report.advisoryStatus);
  if (advisory !== "pass") return "warn";

  const overall = mapHealthStatus(report.overallStatus);
  return overall === "fail" ? "warn" : overall;
}

function summarize(report: ParsedHealthReport): string {
  const status = `health status ${report.overallStatus} (blocking ${report.blockingStatus}, advisory ${report.advisoryStatus})`;
  const flagged = report.riskFlags.slice(0, 2).map((flag) => flag.id);
  if (flagged.length > 0) return `${status}; flags: ${flagged.join(", ")}`;
  const warned = report.warnings.slice(0, 2).map((warning) => warning.id);
  if (warned.length > 0) return `${status}; warnings: ${warned.join(", ")}`;
  return status;
}

function fail(reason: string, details: HealthSummaryDetails): JobCheck<HealthSummaryDetails> {
  return { job: "health-summary", status: "fail", reason, details };
}

function firstLine(text: string): string {
  return text.trim().split(/\r?\n/, 1)[0] || "no output";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
