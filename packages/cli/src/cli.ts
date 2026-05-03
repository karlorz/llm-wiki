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
import { runPath } from "./commands/path.js";
import { runLang } from "./commands/lang.js";
import { runInit } from "./commands/init.js";

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

program
  .command("path")
  .option("--vault <dir>", "explicit vault override (runtime)")
  .option("--target <dir>", "explicit target override (init-time)")
  .option("--init-time", "use init-time chain instead of runtime", false)
  .option("--explain", "include resolution chain in output", false)
  .action(async (opts) => {
    const initTime = !!opts.initTime;
    const flag = initTime ? opts.target : opts.vault;
    emit(await runPath({
      flag,
      envValue: process.env.WIKI_PATH,
      home: process.env.HOME ?? "",
      initTime,
      explain: !!opts.explain
    }));
  });

program
  .command("lang")
  .option("--lang <code>", "explicit language override")
  .option("--explain", "include resolution chain in output", false)
  .action(async (opts) => {
    emit(await runLang({
      flag: opts.lang,
      envValue: process.env.WIKI_LANG,
      home: process.env.HOME ?? "",
      explain: !!opts.explain
    }));
  });

program
  .command("init")
  .option("--target <dir>", "explicit target directory")
  .requiredOption("--domain <text>", "knowledge domain seed")
  .option("--taxonomy <csv>", "comma-separated tag list")
  .option("--lang <code>", "output language (BCP 47 or alias)")
  .option("--force", "override existing target / env conflict", false)
  .action(async (opts) => {
    const templates = new URL("../templates/", import.meta.url).pathname;
    const taxonomy = typeof opts.taxonomy === "string"
      ? opts.taxonomy.split(",").map((s: string) => s.trim()).filter((s: string) => s.length > 0)
      : undefined;
    emit(await runInit({
      flag: opts.target,
      envValue: process.env.WIKI_PATH,
      home: process.env.HOME ?? "",
      templates,
      domain: opts.domain,
      taxonomy,
      lang: opts.lang,
      force: !!opts.force
    }));
  });

program.parseAsync(process.argv).catch((e) => {
  process.stdout.write(JSON.stringify({ ok: false, error: "INTERNAL", detail: { message: String(e) } }) + "\n");
  process.exit(1);
});
