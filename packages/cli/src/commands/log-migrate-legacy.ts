import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ExitCode, err, ok, type Result } from "@skillwiki/shared";
import { operationId } from "../utils/operation-id.js";
import { writeLogEvent, type SkillwikiLogEventV1 } from "../utils/log-events.js";

export interface LogMigrateLegacyInput {
  vault: string;
  write: boolean;
  hostId?: string;
}

export interface LogMigrateLegacyOutput {
  planned: number;
  created: number;
  already_covered: number;
  dry_run: boolean;
  humanHint: string;
}

const BLOCK_RE = /^## \[(\d{4}-\d{2}-\d{2})\][^\n]*$/gm;
const PUBLISH_RE = /<!--\s*skillwiki-page-publish:([a-f0-9]{64})\s*-->/i;

function splitLegacyBlocks(text: string): Array<{ date: string; block: string; ordinal: number }> {
  const matches = [...text.matchAll(BLOCK_RE)];
  if (matches.length === 0) return [];
  const out: Array<{ date: string; block: string; ordinal: number }> = [];
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i]!;
    const start = m.index ?? 0;
    const end = i + 1 < matches.length ? (matches[i + 1]!.index ?? text.length) : text.length;
    const block = text.slice(start, end).replace(/\s+$/, "") + "\n";
    out.push({ date: m[1]!, block, ordinal: i });
  }
  return out;
}

export async function runLogMigrateLegacy(
  input: LogMigrateLegacyInput,
): Promise<{ exitCode: number; result: Result<LogMigrateLegacyOutput> }> {
  let text = "";
  try {
    text = readFileSync(join(input.vault, "log.md"), "utf8");
  } catch {
    return {
      exitCode: ExitCode.OK,
      result: ok({
        planned: 0,
        created: 0,
        already_covered: 0,
        dry_run: !input.write,
        humanHint: "no root log.md to migrate",
      }),
    };
  }

  const blocks = splitLegacyBlocks(text);
  let created = 0;
  let already = 0;
  for (const b of blocks) {
    const publish = PUBLISH_RE.exec(b.block)?.[1]?.toLowerCase();
    const op =
      publish && /^[0-9a-f]{64}$/.test(publish)
        ? publish
        : operationId("skillwiki-legacy-log-v1", [b.date, String(b.ordinal), b.block]);
    const heading = b.block.split("\n")[0] ?? `## [${b.date}] legacy`;
    const event: SkillwikiLogEventV1 = {
      schema: "skillwiki-log-event/v1",
      operation_id: op,
      occurred_at: `${b.date}T00:00:00.000Z`,
      host_id: input.hostId ?? "standalone",
      actor: "skillwiki-cli",
      kind: "legacy-log-entry",
      target: "log.md",
      note: heading,
      metadata: { legacy_markdown: b.block },
    };
    if (!input.write) continue;
    const wrote = await writeLogEvent(input.vault, event);
    if (!wrote.ok) {
      if (wrote.error === "EVENT_IDENTITY_COLLISION") {
        already += 1;
        continue;
      }
      return { exitCode: ExitCode.WRITE_FAILED, result: wrote };
    }
    if (wrote.data.created) created += 1;
    else already += 1;
  }

  return {
    exitCode: ExitCode.OK,
    result: ok({
      planned: blocks.length,
      created: input.write ? created : 0,
      already_covered: input.write ? already : 0,
      dry_run: !input.write,
      humanHint: input.write
        ? `migrated legacy log: created=${created} already=${already} planned=${blocks.length}`
        : `dry run: would migrate ${blocks.length} legacy log block(s)`,
    }),
  };
}
