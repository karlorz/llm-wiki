import { describe, it, expect, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const lintDeferred = vi.hoisted(() => {
  let resolve!: (value: {
    exitCode: number;
    result: {
      ok: true;
      data: {
        vault: { path: string; source: string };
        summary: { errors: number; warnings: number; info: number };
        buckets: Array<{
          kind: string;
          severity: "error" | "warning" | "info";
          count: number;
          examples: string[];
          examples_limit: number;
          sample_truncated: boolean;
          details_command: string;
        }>;
        details_included: false;
        truncated: false;
        fixed: string[];
        unresolved: string[];
        humanHint: string;
      };
    };
  }) => void;
  const promise = new Promise<{
    exitCode: number;
    result: {
      ok: true;
      data: {
        vault: { path: string; source: string };
        summary: { errors: number; warnings: number; info: number };
        buckets: Array<{
          kind: string;
          severity: "error" | "warning" | "info";
          count: number;
          examples: string[];
          examples_limit: number;
          sample_truncated: boolean;
          details_command: string;
        }>;
        details_included: false;
        truncated: false;
        fixed: string[];
        unresolved: string[];
        humanHint: string;
      };
    };
  }>((r) => {
    resolve = r;
  });
  return { promise, resolve };
});

vi.mock("../../src/commands/doctor.js", () => ({
  runDoctor: vi.fn(async () => ({
    exitCode: 0,
    result: {
      ok: true as const,
      data: {
        summary: { pass: 1, info: 0, warn: 0, error: 0 },
        checks: [] as Array<{ id: string; status: "pass" | "info" | "warn" | "error"; detail: string }>,
      },
    },
  })),
}));

vi.mock("../../src/commands/lint.js", () => ({
  runLint: vi.fn(() => lintDeferred.promise),
}));

const { runHealth } = await import("../../src/commands/health.js");

function makeVault(): string {
  const v = mkdtempSync(join(tmpdir(), "health-provisional-vault-"));
  writeFileSync(join(v, "SCHEMA.md"), "# Vault Schema\n");
  writeFileSync(join(v, "index.md"), "# Index\n");
  writeFileSync(join(v, "log.md"), "# Vault Log\n");
  return v;
}

function makeHome(): string {
  const h = mkdtempSync(join(tmpdir(), "health-provisional-home-"));
  mkdirSync(join(h, ".skillwiki"), { recursive: true });
  return h;
}

describe("runHealth provisional report", () => {
  it("writes an incomplete report before lint finishes, then overwrites it with the final report", async () => {
    const vault = makeVault();
    const home = makeHome();
    const out = join(tmpdir(), `skillwiki-health-provisional-${Date.now()}.json`);

    const pending = runHealth({
      vault,
      home,
      envValue: undefined,
      argv: ["node", "skillwiki", "health"],
      currentVersion: "0.9.42-test",
      sync: "off",
      noFail: true,
      out,
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(existsSync(out)).toBe(true);
    const provisionalEnvelope = JSON.parse(readFileSync(out, "utf8"));
    expect(provisionalEnvelope.ok).toBe(true);
    expect(provisionalEnvelope.data.report_complete).toBe(false);
    expect(provisionalEnvelope.data.report_written).toBe(true);
    expect(provisionalEnvelope.data.coverage.lint.state).toBe("unknown");
    expect(provisionalEnvelope.data.overall_status).toBe("unknown");
    expect(
      provisionalEnvelope.data.warnings.some((warning: { id: string }) => warning.id === "health_report_incomplete"),
    ).toBe(true);

    lintDeferred.resolve({
      exitCode: 0,
      result: {
        ok: true,
        data: {
          vault: { path: vault, source: "resolved" },
          summary: { errors: 0, warnings: 0, info: 0 },
          buckets: [],
          details_included: false,
          truncated: false,
          fixed: [],
          unresolved: [],
          humanHint: "lint clean",
        },
      },
    });

    const result = await pending;
    expect(result.exitCode).toBe(0);
    expect(result.result.ok).toBe(true);
    if (result.result.ok) {
      expect(result.result.data.report_complete).toBe(true);
      expect(result.result.data.report_written).toBe(true);
    }

    const finalEnvelope = JSON.parse(readFileSync(out, "utf8"));
    expect(finalEnvelope.ok).toBe(true);
    expect(finalEnvelope.data.report_complete).toBe(true);
    expect(finalEnvelope.data.coverage.lint.state).toBe("checked");
    expect(finalEnvelope.data.components.lint.summary.errors).toBe(0);
    expect(
      finalEnvelope.data.warnings.some((warning: { id: string }) => warning.id === "health_report_incomplete"),
    ).toBe(false);
  });
});
