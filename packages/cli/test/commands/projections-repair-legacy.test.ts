import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ExitCode, err, ok } from "@skillwiki/shared";
import { describe, expect, it } from "vitest";
import {
  runProjectionsRepairLegacy,
  type ProjectionsRepairLegacyDeps,
} from "../../src/commands/projections-repair-legacy.js";
import { canonicalEventJson, readLogEvents, type SkillwikiLogEventV1 } from "../../src/utils/log-events.js";

const BIN = join(__dirname, "..", "..", "dist", "cli.js");
const OPERATION_ID = "935160fbcf568bbcf58d7b1128a9029d15e580af6babced7e19599d15e1dd7bb";
const EVENT_DAY = "2026-07-20";
const INDEX_REVERSED = [
  "# Vault Index",
  "",
  "<!-- skillwiki:index-unmanaged:end -->",
  "",
  "<!-- skillwiki:index-unmanaged:start -->",
  "",
].join("\n");
const INDEX_CANONICAL = [
  "# Vault Index",
  "",
  "<!-- skillwiki:index-unmanaged:start -->",
  "",
  "<!-- skillwiki:index-unmanaged:end -->",
  "",
].join("\n");

const LEGACY_EVENT = {
  operation_id: OPERATION_ID,
  kind: "revise",
  target: "queries/2026-07-20-cmux-hexclave-migration-plan.md",
  note: "Cite official migration.md alongside the HTML alias",
  created: "2026-07-20T00:00:00Z",
};

function eventPath(vault: string, day = EVENT_DAY): string {
  return join(vault, "meta", "log-events", day, `${OPERATION_ID}.json`);
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function makeVault(input: { index?: string; event?: unknown; day?: string } = {}): string {
  const vault = mkdtempSync(join(tmpdir(), "projections-repair-legacy-"));
  writeFileSync(join(vault, "index.md"), input.index ?? INDEX_REVERSED);
  writeJson(eventPath(vault, input.day), input.event ?? LEGACY_EVENT);
  return vault;
}

function canonicalEvent(hostId = "standalone"): SkillwikiLogEventV1 {
  return {
    schema: "skillwiki-log-event/v1",
    operation_id: OPERATION_ID,
    occurred_at: "2026-07-20T00:00:00.000Z",
    host_id: hostId,
    actor: "skillwiki-cli",
    kind: LEGACY_EVENT.kind,
    target: LEGACY_EVENT.target,
    note: LEGACY_EVENT.note,
    metadata: {},
  };
}

function runCli(args: string[]): { stdout: string; status: number } {
  try {
    const stdout = execFileSync("node", [BIN, ...args], { encoding: "utf8" });
    return { stdout, status: 0 };
  } catch (error: unknown) {
    const failure = error as { stdout?: Buffer | string; status?: number };
    return { stdout: failure.stdout?.toString() ?? "", status: failure.status ?? 1 };
  }
}

describe("projections repair-legacy", () => {
  it("previews both repairs without changing either file", async () => {
    const vault = makeVault();
    const beforeIndex = readFileSync(join(vault, "index.md"));
    const beforeEvent = readFileSync(eventPath(vault));

    const result = await runProjectionsRepairLegacy({
      vault,
      eventOperationId: OPERATION_ID,
      write: false,
    });

    expect(result.exitCode).toBe(0);
    expect(result.result).toMatchObject({
      ok: true,
      data: {
        dry_run: true,
        index_repair_needed: true,
        event_repair_needed: true,
        index_changed: false,
        event_changed: false,
      },
    });
    expect(readFileSync(join(vault, "index.md"))).toEqual(beforeIndex);
    expect(readFileSync(eventPath(vault))).toEqual(beforeEvent);
  });

  it("writes both repairs and produces an event accepted by the event reader", async () => {
    const vault = makeVault();

    const result = await runProjectionsRepairLegacy({
      vault,
      eventOperationId: OPERATION_ID,
      write: true,
      hostId: "macbook-writer",
    });

    expect(result.exitCode).toBe(0);
    expect(result.result).toMatchObject({
      ok: true,
      data: {
        dry_run: false,
        index_changed: true,
        event_changed: true,
        rolled_back: false,
      },
    });
    expect(readFileSync(join(vault, "index.md"), "utf8")).toBe(INDEX_CANONICAL);
    expect(readFileSync(eventPath(vault), "utf8")).toBe(canonicalEventJson(canonicalEvent("macbook-writer")));
    await expect(readLogEvents(vault)).resolves.toMatchObject({ ok: true, data: [canonicalEvent("macbook-writer")] });
  });

  it("is a byte-preserving no-op for canonical markers and event", async () => {
    const vault = makeVault({ index: INDEX_CANONICAL, event: canonicalEvent() });
    const beforeIndex = readFileSync(join(vault, "index.md"));
    const beforeEvent = readFileSync(eventPath(vault));

    const result = await runProjectionsRepairLegacy({
      vault,
      eventOperationId: OPERATION_ID,
      write: true,
    });

    expect(result.result).toMatchObject({
      ok: true,
      data: {
        index_repair_needed: false,
        event_repair_needed: false,
        index_changed: false,
        event_changed: false,
      },
    });
    expect(readFileSync(join(vault, "index.md"))).toEqual(beforeIndex);
    expect(readFileSync(eventPath(vault))).toEqual(beforeEvent);
  });

  it.each([
    ["non-whitespace between reversed markers", INDEX_REVERSED.replace("\n\n<!-- skillwiki:index-unmanaged:start -->", "\nowned text\n<!-- skillwiki:index-unmanaged:start -->")],
    ["duplicate markers", INDEX_REVERSED + "<!-- skillwiki:index-unmanaged:start -->\n"],
    ["an incomplete pair", "# Vault Index\n\n<!-- skillwiki:index-unmanaged:start -->\n"],
    ["no markers", "# Vault Index\n"],
  ])("rejects %s", async (_label, index) => {
    const result = await runProjectionsRepairLegacy({
      vault: makeVault({ index }),
      eventOperationId: OPERATION_ID,
      write: false,
    });
    expect(result.exitCode).toBe(4);
    expect(result.result).toMatchObject({ ok: false, error: "SCHEME_REJECTED" });
  });

  it("rejects a legacy event with extra fields", async () => {
    const result = await runProjectionsRepairLegacy({
      vault: makeVault({ event: { ...LEGACY_EVENT, unexpected: true } }),
      eventOperationId: OPERATION_ID,
      write: false,
    });
    expect(result.exitCode).toBe(4);
    expect(result.result).toMatchObject({ ok: false, error: "SCHEME_REJECTED" });
  });

  it("rejects an invalid operation ID", async () => {
    const result = await runProjectionsRepairLegacy({
      vault: makeVault(),
      eventOperationId: "not-an-operation-id",
      write: false,
    });
    expect(result.exitCode).toBe(4);
    expect(result.result).toMatchObject({ ok: false, error: "SCHEME_REJECTED" });
  });

  it("rejects multiple event files with the requested operation ID", async () => {
    const vault = makeVault();
    writeJson(eventPath(vault, "2026-07-21"), LEGACY_EVENT);
    const result = await runProjectionsRepairLegacy({
      vault,
      eventOperationId: OPERATION_ID,
      write: false,
    });
    expect(result.exitCode).toBe(4);
    expect(result.result).toMatchObject({ ok: false, error: "SCHEME_REJECTED" });
  });

  it("rejects a path/date mismatch", async () => {
    const result = await runProjectionsRepairLegacy({
      vault: makeVault({ day: "2026-07-21" }),
      eventOperationId: OPERATION_ID,
      write: false,
    });
    expect(result.exitCode).toBe(4);
    expect(result.result).toMatchObject({ ok: false, error: "SCHEME_REJECTED" });
  });

  it("rejects a path/operation mismatch", async () => {
    const event = { ...LEGACY_EVENT, operation_id: "a".repeat(64) };
    const result = await runProjectionsRepairLegacy({
      vault: makeVault({ event }),
      eventOperationId: OPERATION_ID,
      write: false,
    });
    expect(result.exitCode).toBe(4);
    expect(result.result).toMatchObject({ ok: false, error: "SCHEME_REJECTED" });
  });

  it("rejects an invalid timestamp", async () => {
    const event = { ...LEGACY_EVENT, created: "2026-02-30T00:00:00Z" };
    const result = await runProjectionsRepairLegacy({
      vault: makeVault({ event, day: "2026-02-30" }),
      eventOperationId: OPERATION_ID,
      write: false,
    });
    expect(result.exitCode).toBe(4);
    expect(result.result).toMatchObject({ ok: false, error: "SCHEME_REJECTED" });
  });

  it("restores index.md if the event write fails", async () => {
    const vault = makeVault();
    const originalIndex = readFileSync(join(vault, "index.md"), "utf8");
    let writes = 0;
    const deps: ProjectionsRepairLegacyDeps = {
      writeText: async (path, text) => {
        writes += 1;
        if (writes === 2) return err("WRITE_FAILED", { message: "injected event failure" });
        writeFileSync(path, text);
        return ok({ changed: true, existed: true });
      },
    };

    const result = await runProjectionsRepairLegacy(
      { vault, eventOperationId: OPERATION_ID, write: true },
      deps,
    );

    expect(result.exitCode).toBe(ExitCode.WRITE_FAILED);
    expect(result.result).toMatchObject({
      ok: false,
      error: "WRITE_FAILED",
      detail: { rolled_back: true },
    });
    expect(readFileSync(join(vault, "index.md"), "utf8")).toBe(originalIndex);
    expect(JSON.parse(readFileSync(eventPath(vault), "utf8"))).toEqual(LEGACY_EVENT);
  });

  it("documents the bounded repair and managed-write options", () => {
    const help = runCli(["projections", "repair-legacy", "--help"]);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("--event-operation-id <id>");
    expect(help.stdout).toContain("--write");
    expect(help.stdout).toContain("--converge-vault <dir>");
  });
});
