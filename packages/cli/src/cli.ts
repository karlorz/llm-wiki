import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Command } from "commander";
import type { Result, ErrResult } from "@skillwiki/shared";
import { ExitCode } from "@skillwiki/shared";
import { printJson, printHuman } from "./utils/output.js";
import { getDeprecatedWarnings } from "./utils/deprecation.js";
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
import { runConfigGet, runConfigSet, runConfigList, runConfigPath } from "./commands/config.js";
import { runDoctor } from "./commands/doctor.js";
import { runArchive } from "./commands/archive.js";
import { runDrift } from "./commands/drift.js";
import { runDedup } from "./commands/dedup.js";
import { runMigrateCitations } from "./commands/migrate-citations.js";
import { runFrontmatterFix } from "./commands/frontmatter-fix.js";
import { runUpdate } from "./commands/update.js";
import { runSelfUpdate } from "./commands/self-update.js";
import { runTranscripts } from "./commands/transcripts.js";
import { runProjectIndex } from "./commands/project-index.js";
import { runCompound, runCompoundList, runCompoundDelete } from "./commands/compound.js";
import { runObserve } from "./commands/observe.js";
import { runIngest } from "./commands/ingest.js";
import { runTagSync } from "./commands/tag-sync.js";
import { runSyncStatus, runSyncPush, runSyncPull } from "./commands/sync.js";
import { runBackupSync, runBackupRestore } from "./commands/backup.js";
import { runStatus } from "./commands/status.js";
import { runSeed } from "./commands/seed.js";
import { runCanvasGenerate } from "./commands/canvas.js";
import { runQuery } from "./commands/query.js";
import { runIndexLinkFormat } from "./commands/index-link-format.js";
import { runTopicMapCheck } from "./commands/topic-map-check.js";
import { resolveRuntimePath } from "./utils/wiki-path.js";
import { postCommit } from "./utils/auto-commit.js";
import { triggerAutoUpdate } from "./utils/auto-update.js";
import { parseDotenvFile } from "./utils/dotenv.js";
import { configPath } from "./commands/config.js";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

const program = new Command();
program.name("skillwiki").description("Deterministic helpers for CodeWiki skills").version(pkg.version);
program.option("--human", "render terminal-readable output instead of JSON");

async function emit<T>(r: { exitCode: number; result: Result<T> }, vault?: string): Promise<never> {
  if (program.opts().human) printHuman(r.result); else printJson(r.result);
  if (vault) await postCommit(vault, r.exitCode);
  process.exit(r.exitCode);
}

program.command("hash <file>").description("compute SHA-256 hash of a vault page body").action(async (file) => emit(await runHash({ file })));

program.command("fetch-guard <url>").description("check if a URL passes fetch guard rules and sanitize secrets").action(async (url) => emit(await runFetchGuard({ url })));

program
  .command("validate <file>")
  .description("validate vault page frontmatter against its detected schema")
  .option("--apply", "auto-update vault index.md and log.md after successful validation", false)
  .option("--vault <dir>", "vault root directory (required with --apply)")
  .option("--wiki <name>", "wiki profile name")
  .action(async (file, opts) => {
    let vault: string | undefined;
    if (opts.apply) {
      const v = await resolveVaultArg(opts.vault, opts.wiki);
      if (!v.ok) emit({ exitCode: v.exitCode, result: v.payload });
      else vault = v.vault;
    }
    emit(await runValidate({ file, apply: !!opts.apply, vault }), vault);
  });

program
  .command("graph")
  .description("graph subcommands")
  .command("build <vault>")
  .option("--out <path>", "graph output path (default: <vault>/.skillwiki/graph.json)")
  .option("--wiki <name>", "wiki profile name")
  .action(async (vault, opts) => {
    const out = opts.out ?? join(vault, ".skillwiki", "graph.json");
    emit(await runGraphBuild({ vault, out }), vault);
  });

const canvasCmd = program.command("canvas").description("manage Obsidian canvas files");

canvasCmd
  .command("generate [vault]")
  .description("generate .canvas from graph.json")
  .option("--graph-path <path>", "explicit path to graph.json")
  .option("--wiki <name>", "wiki profile name")
  .action(async (vault, opts) => {
    const v = await resolveVaultArg(vault, opts.wiki);
    if (!v.ok) emit({ exitCode: v.exitCode, result: v.payload });
    else emit(await runCanvasGenerate({ vault: v.vault, graphPath: opts.graphPath }), v.vault);
  });

program
  .command("overlap [vault]")
  .description("detect typed-knowledge pages that share the same raw sources")
  .option("--wiki <name>", "wiki profile name")
  .action(async (vault, opts) => {
    const v = await resolveVaultArg(vault, opts.wiki);
    if (!v.ok) emit({ exitCode: v.exitCode, result: v.payload });
    else emit(await runOverlap({ vault: v.vault }), v.vault);
  });

program
  .command("query <text> [vault]")
  .description("score and rank vault pages by relevance to a query")
  .option("--limit <n>", "max results to return", (s) => parseInt(s, 10), 10)
  .option("--wiki <name>", "wiki profile name")
  .action(async (text, vault, opts) => {
    const v = await resolveVaultArg(vault, opts.wiki);
    if (!v.ok) emit({ exitCode: v.exitCode, result: v.payload });
    else emit(await runQuery({ text, vault: v.vault, limit: opts.limit }), v.vault);
  });

program
  .command("orphans [vault]")
  .description("find pages not referenced by any other page")
  .option("--wiki <name>", "wiki profile name")
  .action(async (vault, opts) => emit(await runOrphans({
    vault,
    envValue: process.env.WIKI_PATH,
    home: process.env.HOME ?? "",
    wiki: opts.wiki
  })));

program.command("audit <file>").description("audit citation markers and source provenance for a vault page").action(async (file) => emit(await runAudit({ file })));

program
  .command("install")
  .description("install skillwiki SKILL.md files into ~/.claude/skills/")
  .option("--target <dir>", "target install directory", `${process.env.HOME ?? ""}/.claude/skills/`)
  .option("--dry-run", "preview only", false)
  .option("--skills-root <dir>", "source skills directory (defaults to packaged)")
  .option("--symlink", "create symlinks instead of copies (dev mode — edits to source are immediately visible)", false)
  .action(async (opts) => {
    const skillsRoot = opts.skillsRoot ?? new URL("../skills/", import.meta.url).pathname;
    emit(await runInstall({ skillsRoot, target: opts.target, dryRun: !!opts.dryRun, symlink: !!opts.symlink }));
  });

program
  .command("path")
  .description("show the resolved vault path")
  .option("--vault <dir>", "explicit vault override (runtime)")
  .option("--target <dir>", "explicit target override (init-time)")
  .option("--wiki <name>", "wiki profile name")
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
      wiki: opts.wiki,
      explain: !!opts.explain
    }));
  });

program
  .command("lang")
  .description("get or set the vault language")
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
  .description("bootstrap a new vault with SCHEMA.md, index.md, log.md")
  .option("--target <dir>", "explicit target directory")
  .requiredOption("--domain <text>", "knowledge domain seed")
  .option("--taxonomy <csv>", "comma-separated tag list")
  .option("--lang <code>", "output language (BCP 47 or alias)")
  .option("--force", "override existing target / env conflict", false)
  .option("--no-env", "skip writing ~/.skillwiki/.env")
  .option("--profile <name>", "write as named wiki profile instead of WIKI_PATH")
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
      force: !!opts.force,
      noEnv: opts.env === false,
      profile: opts.profile
    }));
  });

async function resolveVaultArg(arg: string | undefined, wiki?: string): Promise<{ ok: true; vault: string } | { ok: false; exitCode: number; payload: ErrResult }> {
  if (arg) return { ok: true, vault: arg };
  const r = await resolveRuntimePath({
    flag: undefined,
    envValue: process.env.WIKI_PATH,
    wikiEnv: process.env.WIKI,
    home: process.env.HOME ?? "",
    wiki
  });
  if (!r.ok) {
    const exitCode = r.error === "UNKNOWN_WIKI_PROFILE" ? 35 : 25;
    return { ok: false, exitCode, payload: r };
  }
  return { ok: true, vault: r.data.path };
}

program.command("links [vault]")
  .description("check wikilink integrity across the vault")
  .option("--wiki <name>", "wiki profile name")
  .action(async (vault, opts) => {
    const v = await resolveVaultArg(vault, opts.wiki);
    if (!v.ok) emit({ exitCode: v.exitCode, result: v.payload });
    else emit(await runLinks({ vault: v.vault }), v.vault);
  });

program.command("tag-audit [vault]")
  .description("audit tag taxonomy consistency")
  .option("--wiki <name>", "wiki profile name")
  .action(async (vault, opts) => {
    const v = await resolveVaultArg(vault, opts.wiki);
    if (!v.ok) emit({ exitCode: v.exitCode, result: v.payload });
    else emit(await runTagAudit({ vault: v.vault }), v.vault);
  });

program.command("index-check [vault]")
  .description("verify index.md entries match actual vault pages")
  .option("--wiki <name>", "wiki profile name")
  .action(async (vault, opts) => {
    const v = await resolveVaultArg(vault, opts.wiki);
    if (!v.ok) emit({ exitCode: v.exitCode, result: v.payload });
    else emit(await runIndexCheck({ vault: v.vault }), v.vault);
  });

program.command("index-link-format [vault]")
  .description("check index.md for markdown links that should be wikilinks")
  .option("--wiki <name>", "wiki profile name")
  .action(async (vault, opts) => {
    const v = await resolveVaultArg(vault, opts.wiki);
    if (!v.ok) emit({ exitCode: v.exitCode, result: v.payload });
    else emit(await runIndexLinkFormat({ vault: v.vault }), v.vault);
  });

program.command("topic-map-check [vault]")
  .description("check whether a topic map page is recommended based on page count")
  .option("--threshold <n>", "page count threshold", (s) => parseInt(s, 10), 200)
  .option("--wiki <name>", "wiki profile name")
  .action(async (vault, opts) => {
    const v = await resolveVaultArg(vault, opts.wiki);
    if (!v.ok) emit({ exitCode: v.exitCode, result: v.payload });
    else emit(await runTopicMapCheck({ vault: v.vault, threshold: opts.threshold }), v.vault);
  });

program
  .command("stale [vault]")
  .description("identify stale transcripts and incomplete work items")
  .option("--archive", "move stale items to _archive/", false)
  .option("--days <n>", "staleness threshold in days", (s) => parseInt(s, 10), 3)
  .option("--wiki <name>", "wiki profile name")
  .action(async (vault, opts) => {
    const v = await resolveVaultArg(vault, opts.wiki);
    if (!v.ok) emit({ exitCode: v.exitCode, result: v.payload });
    else emit(await runStale({ vault: v.vault, days: opts.days, archive: !!opts.archive }), v.vault);
  });

program
  .command("pagesize [vault]")
  .description("report page sizes and flag oversized pages")
  .option("--lines <n>", "max body lines", (s) => parseInt(s, 10), 200)
  .option("--wiki <name>", "wiki profile name")
  .action(async (vault, opts) => {
    const v = await resolveVaultArg(vault, opts.wiki);
    if (!v.ok) emit({ exitCode: v.exitCode, result: v.payload });
    else emit(await runPagesize({ vault: v.vault, lines: opts.lines }), v.vault);
  });

program
  .command("log-rotate [vault]")
  .description("rotate or trim the vault log file")
  .option("--threshold <n>", "entry count threshold", (s) => parseInt(s, 10), 500)
  .option("--apply", "actually rotate", false)
  .option("--wiki <name>", "wiki profile name")
  .action(async (vault, opts) => {
    const v = await resolveVaultArg(vault, opts.wiki);
    if (!v.ok) emit({ exitCode: v.exitCode, result: v.payload });
    else emit(await runLogRotate({ vault: v.vault, threshold: opts.threshold, apply: !!opts.apply }), v.vault);
  });

program
  .command("lint [vault]")
  .description("run all vault health checks")
  .option("--days <n>", "stale threshold", (s) => parseInt(s, 10), 90)
  .option("--lines <n>", "pagesize threshold", (s) => parseInt(s, 10), 200)
  .option("--log-threshold <n>", "log rotation threshold", (s) => parseInt(s, 10), 500)
  .option("--fix", "auto-fix legacy_citation_style violations")
  .option("--wiki <name>", "wiki profile name")
  .action(async (vault, opts) => {
    const v = await resolveVaultArg(vault, opts.wiki);
    if (!v.ok) emit({ exitCode: v.exitCode, result: v.payload });
    else emit(await runLint({
      vault: v.vault,
      source: vault ? "flag" : undefined,
      days: opts.days,
      lines: opts.lines,
      logThreshold: opts.logThreshold,
      fix: opts.fix ?? false
    }), v.vault);
  });

// config — grouped under a parent command
const configCmd = program.command("config").description("manage skillwiki configuration");

configCmd
  .command("get <key>")
  .description("print the value of a config key")
  .action(async (key) => emit(await runConfigGet({ key, home: process.env.HOME ?? "" })));

configCmd
  .command("set <key> <value>")
  .description("set a config key value")
  .action(async (key, value) => emit(await runConfigSet({ key, value, home: process.env.HOME ?? "" })));

configCmd
  .command("list")
  .option("--profiles", "show wiki profiles summary", false)
  .description("list all config key=value pairs")
  .action(async (opts) => emit(await runConfigList({ home: process.env.HOME ?? "", profiles: !!opts.profiles })));

configCmd
  .command("path")
  .description("print the config file path")
  .action(async () => emit(await runConfigPath({ home: process.env.HOME ?? "" })));

// doctor
program
  .command("doctor")
  .description("diagnose skillwiki setup issues")
  .action(async () => emit(await runDoctor({
    home: process.env.HOME ?? "",
    envValue: process.env.WIKI_PATH,
    argv: process.argv,
    currentVersion: pkg.version,
    cwd: process.cwd(),
  })));

// status
program
  .command("status [vault]")
  .description("output vault diagnostics")
  .option("--wiki <name>", "wiki profile name")
  .action(async (vault, opts) => {
    const v = await resolveVaultArg(vault, opts.wiki);
    if (!v.ok) emit({ exitCode: v.exitCode, result: v.payload });
    else emit(await runStatus({
      vault: v.vault,
      home: process.env.HOME ?? "",
      langEnvValue: process.env.WIKI_LANG,
    }), v.vault);
  });

// archive
program
  .command("archive <page> [vault]")
  .description("archive a typed-knowledge or raw page")
  .option("--wiki <name>", "wiki profile name")
  .action(async (page, vault, opts) => {
    const v = await resolveVaultArg(vault, opts.wiki);
    if (!v.ok) emit({ exitCode: v.exitCode, result: v.payload });
    else emit(await runArchive({ vault: v.vault, page }), v.vault);
  });

// drift
program
  .command("drift [vault]")
  .description("detect content drift in raw sources")
  .option("--apply", "update sha256 in drifted sources")
  .option("--new <date>", "list raw files ingested on/after this date (YYYY-MM-DD)")
  .option("--wiki <name>", "wiki profile name")
  .action(async (vault, opts) => {
    const v = await resolveVaultArg(vault, opts.wiki);
    if (!v.ok) emit({ exitCode: v.exitCode, result: v.payload });
    else emit(await runDrift({ vault: v.vault, apply: opts.apply, newSince: opts.new }), v.vault);
  });

// dedup
program
  .command("dedup [vault]")
  .description("detect duplicate raw sources by sha256")
  .option("--apply", "rewire citations and remove duplicate raw files", false)
  .option("--wiki <name>", "wiki profile name")
  .action(async (vault, opts) => {
    const v = await resolveVaultArg(vault, opts.wiki);
    if (!v.ok) emit({ exitCode: v.exitCode, result: v.payload });
    else emit(await runDedup({ vault: v.vault, apply: opts.apply }), v.vault);
  });

// migrate-citations
program
  .command("migrate-citations [vault]")
  .description("migrate ^[raw/...] markers to paragraph-end citations")
  .option("--dry-run", "preview changes without writing", false)
  .option("--wiki <name>", "wiki profile name")
  .action(async (vault, opts) => {
    const v = await resolveVaultArg(vault, opts.wiki);
    if (!v.ok) emit({ exitCode: v.exitCode, result: v.payload });
    else emit(await runMigrateCitations({ vault: v.vault, dryRun: !!opts.dryRun }), v.vault);
  });

// frontmatter-fix
program
  .command("frontmatter-fix [vault]")
  .description("fix common frontmatter issues on typed-knowledge pages")
  .option("--dry-run", "preview changes without writing", false)
  .option("--wiki <name>", "wiki profile name")
  .action(async (vault, opts) => {
    const v = await resolveVaultArg(vault, opts.wiki);
    if (!v.ok) emit({ exitCode: v.exitCode, result: v.payload });
    else emit(await runFrontmatterFix({ vault: v.vault, dryRun: !!opts.dryRun }), v.vault);
  });

// update
program
  .command("update")
  .description("update skillwiki CLI to the latest version")
  .option("--tag <tag>", "npm dist-tag", "beta")
  .action(async (opts) => emit(await runUpdate({
    home: process.env.HOME ?? "",
    distTag: opts.tag,
  })));

// self-update
program
  .command("self-update")
  .description("update skillwiki CLI from local source or npm@beta")
  .option("--check", "check for updates without installing", false)
  .action(async (opts) => emit(await runSelfUpdate({
    home: process.env.HOME ?? "",
    check: !!opts.check,
  })));

// transcripts
program
  .command("transcripts [vault]")
  .description("list transcript files in raw/transcripts/")
  .option("--since <date>", "only files ingested on or after this date (YYYY-MM-DD)")
  .option("--wiki <name>", "wiki profile name")
  .action(async (vault, opts) => {
    const v = await resolveVaultArg(vault, opts.wiki);
    if (!v.ok) emit({ exitCode: v.exitCode, result: v.payload });
    else emit(await runTranscripts({ vault: v.vault, since: opts.since }), v.vault);
  });

// project-index
program
  .command("project-index <slug> [vault]")
  .description("generate a knowledge index for a project workspace")
  .option("--apply", "write knowledge.md to the project directory", false)
  .option("--wiki <name>", "wiki profile name")
  .action(async (slug, vault, opts) => {
    const v = await resolveVaultArg(vault, opts.wiki);
    if (!v.ok) emit({ exitCode: v.exitCode, result: v.payload });
    else emit(await runProjectIndex({ vault: v.vault, slug, apply: !!opts.apply }), v.vault);
  });

// compound — grouped under a parent command
const compoundCmd = program.command("compound").description("manage project compound entries");

compoundCmd
  .command("promote [vault]")
  .description("promote retros with Generalize?: yes to compound entries")
  .requiredOption("--project <slug>", "project slug (e.g., llm-wiki)")
  .option("--dry-run", "preview promotions without writing files", false)
  .option("--wiki <name>", "wiki profile name")
  .action(async (vault, opts) => {
    const v = await resolveVaultArg(vault, opts.wiki);
    if (!v.ok) emit({ exitCode: v.exitCode, result: v.payload });
    else emit(await runCompound({ vault: v.vault, project: opts.project, dryRun: !!opts.dryRun }), v.vault);
  });

compoundCmd
  .command("list [vault]")
  .description("list compound entries for a project")
  .requiredOption("--project <slug>", "project slug (e.g., llm-wiki)")
  .option("--wiki <name>", "wiki profile name")
  .action(async (vault, opts) => {
    const v = await resolveVaultArg(vault, opts.wiki);
    if (!v.ok) emit({ exitCode: v.exitCode, result: v.payload });
    else emit(await runCompoundList({ vault: v.vault, project: opts.project }));
  });

compoundCmd
  .command("delete <entry> [vault]")
  .description("delete a compound entry and regenerate knowledge index")
  .requiredOption("--project <slug>", "project slug (e.g., llm-wiki)")
  .option("--wiki <name>", "wiki profile name")
  .action(async (entry, vault, opts) => {
    const v = await resolveVaultArg(vault, opts.wiki);
    if (!v.ok) emit({ exitCode: v.exitCode, result: v.payload });
    else emit(await runCompoundDelete({ vault: v.vault, project: opts.project, entry }), v.vault);
  });

// tag-sync
program
  .command("tag-sync [vault]")
  .description("mirror frontmatter enum values to nested Obsidian tags")
  .option("--dry-run", "preview changes without writing", false)
  .option("--wiki <name>", "wiki profile name")
  .action(async (vault, opts) => {
    const v = await resolveVaultArg(vault, opts.wiki);
    if (!v.ok) emit({ exitCode: v.exitCode, result: v.payload });
    else emit(await runTagSync({ vault: v.vault, dryRun: !!opts.dryRun }), v.vault);
  });

// sync — grouped under a parent command
const syncCmd = program.command("sync").description("manage vault sync");

syncCmd
  .command("status [vault]")
  .description("check vault git sync status")
  .option("--wiki <name>", "wiki profile name")
  .action(async (vault, opts) => {
    const v = await resolveVaultArg(vault, opts.wiki);
    if (!v.ok) emit({ exitCode: v.exitCode, result: v.payload });
    else emit(runSyncStatus({ vault: v.vault }));
  });

syncCmd
  .command("push [vault]")
  .description("lint, commit, and push vault changes to remote")
  .option("--wiki <name>", "wiki profile name")
  .action(async (vault, opts) => {
    const v = await resolveVaultArg(vault, opts.wiki);
    if (!v.ok) emit({ exitCode: v.exitCode, result: v.payload });
    else emit(await runSyncPush({ vault: v.vault }));
  });

syncCmd
  .command("pull [vault]")
  .description("pull remote vault changes and lint")
  .option("--wiki <name>", "wiki profile name")
  .action(async (vault, opts) => {
    const v = await resolveVaultArg(vault, opts.wiki);
    if (!v.ok) emit({ exitCode: v.exitCode, result: v.payload });
    else emit(await runSyncPull({ vault: v.vault }), v.vault);
  });

// backup — grouped under a parent command
const backupCmd = program.command("backup").description("manage S3-compatible remote backup");

backupCmd
  .command("sync [vault]")
  .description("sync vault to S3-compatible remote backup")
  .option("--dry-run", "list actions without executing")
  .option("--bucket <name>", "S3 bucket name")
  .option("--endpoint <url>", "S3 endpoint URL")
  .option("--region <region>", "S3 region", "us-east-1")
  .option("--prune", "delete orphaned S3 objects not in vault", false)
  .option("--wiki <name>", "wiki profile name")
  .action(async (vault, opts) => {
    const v = await resolveVaultArg(vault, opts.wiki);
    if (!v.ok) emit({ exitCode: v.exitCode, result: v.payload });
    const home = process.env.HOME ?? process.env.USERPROFILE ?? "/tmp";
    const dotenv = await parseDotenvFile(configPath(home));
    emit(await runBackupSync({
      vault: v.vault,
      bucket: opts.bucket ?? dotenv["BACKUP_BUCKET"] ?? "",
      endpoint: opts.endpoint ?? dotenv["BACKUP_ENDPOINT"] ?? "",
      region: opts.region ?? dotenv["BACKUP_REGION"] ?? "us-east-1",
      accessKeyId: dotenv["BACKUP_ACCESS_KEY_ID"] ?? "",
      secretAccessKey: dotenv["BACKUP_SECRET_ACCESS_KEY"] ?? "",
      dryRun: opts.dryRun,
      prune: opts.prune,
    }), v.vault);
  });

backupCmd
  .command("restore [vault]")
  .description("restore vault from S3-compatible remote backup")
  .option("--bucket <name>", "S3 bucket name")
  .option("--endpoint <url>", "S3 endpoint URL")
  .option("--region <region>", "S3 region", "us-east-1")
  .option("--target <dir>", "restore target directory (defaults to vault)")
  .option("--wiki <name>", "wiki profile name")
  .action(async (vault, opts) => {
    const v = await resolveVaultArg(vault, opts.wiki);
    if (!v.ok) emit({ exitCode: v.exitCode, result: v.payload });
    const home = process.env.HOME ?? process.env.USERPROFILE ?? "/tmp";
    const dotenv = await parseDotenvFile(configPath(home));
    emit(await runBackupRestore({
      vault: v.vault,
      bucket: opts.bucket ?? dotenv["BACKUP_BUCKET"] ?? "",
      endpoint: opts.endpoint ?? dotenv["BACKUP_ENDPOINT"] ?? "",
      region: opts.region ?? dotenv["BACKUP_REGION"] ?? "us-east-1",
      accessKeyId: dotenv["BACKUP_ACCESS_KEY_ID"] ?? "",
      secretAccessKey: dotenv["BACKUP_SECRET_ACCESS_KEY"] ?? "",
      target: opts.target,
    }), v.vault);
  });

// seed
program
  .command("seed [vault]")
  .description("populate a vault with example content")
  .option("--wiki <name>", "wiki profile name")
  .action(async (vault, opts) => {
    const v = await resolveVaultArg(vault, opts.wiki);
    if (!v.ok) emit({ exitCode: v.exitCode, result: v.payload });
    else emit(await runSeed({ vault: v.vault }), v.vault);
  });

// observe
program
  .command("observe [vault]")
  .description("create a raw transcript observation entry")
  .requiredOption("--text <text>", "observation text")
  .option("--kind <kind>", "observation kind (note|bug|task|idea|session-log)", "note")
  .option("--project <slug>", "associated project slug")
  .option("--wiki <name>", "wiki profile name")
  .action(async (vault, opts) => {
    const v = await resolveVaultArg(vault, opts.wiki);
    if (!v.ok) emit({ exitCode: v.exitCode, result: v.payload });
    else emit(await runObserve({
      vault: v.vault,
      text: opts.text,
      kind: opts.kind,
      project: opts.project
    }), v.vault);
  });

// ingest
program
  .command("ingest <source>")
  .description("ingest a source URL or local file into the vault")
  .requiredOption("--vault <path>", "vault root directory")
  .requiredOption("--type <type>", "typed-knowledge type (entity|concept|comparison|query)")
  .requiredOption("--title <title>", "page title")
  .option("--tags <csv>", "comma-separated tags")
  .option("--provenance <provenance>", "provenance (research|project)")
  .option("--dry-run", "preview without writing files", false)
  .action(async (source, opts) => {
    const tags = typeof opts.tags === "string"
      ? opts.tags.split(",").map((s: string) => s.trim()).filter((s: string) => s.length > 0)
      : [];
    emit(await runIngest({
      source,
      vault: opts.vault,
      type: opts.type,
      title: opts.title,
      tags,
      provenance: opts.provenance,
      dryRun: !!opts.dryRun,
    }), opts.vault);
  });

// Emit deprecation warnings for any installed skills marked deprecated
for (const w of getDeprecatedWarnings(process.env.HOME ?? "")) {
  process.stderr.write(w + "\n");
}

// Background auto-update check (non-blocking, 24h cache)
triggerAutoUpdate(process.env.HOME ?? "", pkg.version);

program.parseAsync(process.argv).catch((e) => {
  process.stdout.write(JSON.stringify({ ok: false, error: "INTERNAL", detail: { message: String(e) } }) + "\n");
  process.exit(ExitCode.INTERNAL_ERROR);
});
