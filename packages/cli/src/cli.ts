import { readFileSync } from "node:fs";
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
import { runLinks } from "./commands/links.js";
import { runTagAudit } from "./commands/tag-audit.js";
import { runIndexCheck } from "./commands/index-check.js";
import { runStale } from "./commands/stale.js";
import { runPagesize } from "./commands/pagesize.js";
import { runLogRotate } from "./commands/log-rotate.js";
import { runLint } from "./commands/lint.js";
import { resolveRuntimePath } from "./utils/wiki-path.js";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

const program = new Command();
program.name("skillwiki").description("Deterministic helpers for CodeWiki skills").version(pkg.version);
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

program
  .command("orphans [vault]")
  .action(async (vault) => emit(await runOrphans({
    vault,
    envValue: process.env.WIKI_PATH,
    home: process.env.HOME ?? ""
  })));

program.command("audit <file>").action(async (file) => emit(await runAudit({ file })));

program
  .command("install")
  .option("--target <dir>", "target install directory", `${process.env.HOME ?? ""}/.claude/skills/`)
  .option("--dry-run", "preview only", false)
  .option("--skills-root <dir>", "source skills directory (defaults to packaged)")
  .action(async (opts) => {
    const skillsRoot = opts.skillsRoot ?? new URL("../skills/", import.meta.url).pathname;
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

async function resolveVaultArg(arg: string | undefined): Promise<{ ok: true; vault: string } | { ok: false; exitCode: number; payload: any }> {
  if (arg) return { ok: true, vault: arg };
  const r = await resolveRuntimePath({
    flag: undefined,
    envValue: process.env.WIKI_PATH,
    home: process.env.HOME ?? ""
  });
  if (!r.ok) return { ok: false, exitCode: 25, payload: r };
  return { ok: true, vault: r.data.path };
}

program.command("links [vault]").action(async (vault) => {
  const v = await resolveVaultArg(vault);
  if (!v.ok) emit({ exitCode: v.exitCode, result: v.payload });
  else emit(await runLinks({ vault: v.vault }));
});

program.command("tag-audit [vault]").action(async (vault) => {
  const v = await resolveVaultArg(vault);
  if (!v.ok) emit({ exitCode: v.exitCode, result: v.payload });
  else emit(await runTagAudit({ vault: v.vault }));
});

program.command("index-check [vault]").action(async (vault) => {
  const v = await resolveVaultArg(vault);
  if (!v.ok) emit({ exitCode: v.exitCode, result: v.payload });
  else emit(await runIndexCheck({ vault: v.vault }));
});

program
  .command("stale [vault]")
  .option("--days <n>", "staleness threshold in days", (s) => parseInt(s, 10), 90)
  .action(async (vault, opts) => {
    const v = await resolveVaultArg(vault);
    if (!v.ok) emit({ exitCode: v.exitCode, result: v.payload });
    else emit(await runStale({ vault: v.vault, days: opts.days }));
  });

program
  .command("pagesize [vault]")
  .option("--lines <n>", "max body lines", (s) => parseInt(s, 10), 200)
  .action(async (vault, opts) => {
    const v = await resolveVaultArg(vault);
    if (!v.ok) emit({ exitCode: v.exitCode, result: v.payload });
    else emit(await runPagesize({ vault: v.vault, lines: opts.lines }));
  });

program
  .command("log-rotate [vault]")
  .option("--threshold <n>", "entry count threshold", (s) => parseInt(s, 10), 500)
  .option("--apply", "actually rotate", false)
  .action(async (vault, opts) => {
    const v = await resolveVaultArg(vault);
    if (!v.ok) emit({ exitCode: v.exitCode, result: v.payload });
    else emit(await runLogRotate({ vault: v.vault, threshold: opts.threshold, apply: !!opts.apply }));
  });

program
  .command("lint [vault]")
  .option("--days <n>", "stale threshold", (s) => parseInt(s, 10), 90)
  .option("--lines <n>", "pagesize threshold", (s) => parseInt(s, 10), 200)
  .option("--log-threshold <n>", "log rotation threshold", (s) => parseInt(s, 10), 500)
  .action(async (vault, opts) => {
    const v = await resolveVaultArg(vault);
    if (!v.ok) emit({ exitCode: v.exitCode, result: v.payload });
    else emit(await runLint({
      vault: v.vault,
      source: vault ? "flag" : undefined,
      days: opts.days,
      lines: opts.lines,
      logThreshold: opts.logThreshold
    }));
  });

program.parseAsync(process.argv).catch((e) => {
  process.stdout.write(JSON.stringify({ ok: false, error: "INTERNAL", detail: { message: String(e) } }) + "\n");
  process.exit(1);
});
