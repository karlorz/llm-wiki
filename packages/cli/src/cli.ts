import { Command } from "commander";
import type { Result } from "@skillwiki/shared";
import { printJson, printHuman } from "./utils/output.js";
import { runHash } from "./commands/hash.js";
import { runFetchGuard } from "./commands/fetch-guard.js";
import { runValidate } from "./commands/validate.js";
import { runGraphBuild } from "./commands/graph.js";
import { runOverlap } from "./commands/overlap.js";
import { runOrphans } from "./commands/orphans.js";
import { runAudit } from "./commands/audit.js";
import { runInstall } from "./commands/install.js";

const program = new Command();
program.name("skillwiki").description("Deterministic helpers for CodeWiki skills").version("0.1.0");
program.option("--human", "render terminal-readable output instead of JSON");

function emit<T>(r: { exitCode: number; result: Result<T> }): never {
  if (program.opts().human) printHuman(r.result); else printJson(r.result);
  process.exit(r.exitCode);
}

program.command("hash <file>").action(async (file) => emit(await runHash({ file })));

program.command("fetch-guard <url>").action(async (url) => emit(await runFetchGuard({ url })));

program.command("validate <file>").action(async (file) => emit(await runValidate({ file })));

program
  .command("graph")
  .description("graph subcommands")
  .command("build <vault>")
  .option("--out <path>", "graph output path", ".skillwiki/graph.json")
  .action(async (vault, opts) => emit(await runGraphBuild({ vault, out: opts.out })));

program.command("overlap <vault>").action(async (vault) => emit(await runOverlap({ vault })));

program.command("orphans <vault>").action(async (vault) => emit(await runOrphans({ vault })));

program.command("audit <file>").action(async (file) => emit(await runAudit({ file })));

program
  .command("install")
  .option("--target <dir>", "target install directory", `${process.env.HOME ?? ""}/.claude/skills/`)
  .option("--dry-run", "preview only", false)
  .option("--skills-root <dir>", "source skills directory (defaults to packaged)")
  .action(async (opts) => {
    const skillsRoot = opts.skillsRoot ?? new URL("../../skills/", import.meta.url).pathname;
    emit(await runInstall({ skillsRoot, target: opts.target, dryRun: !!opts.dryRun }));
  });

program.parseAsync(process.argv).catch((e) => {
  process.stdout.write(JSON.stringify({ ok: false, error: "INTERNAL", detail: { message: String(e) } }) + "\n");
  process.exit(1);
});
