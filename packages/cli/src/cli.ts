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
import { runIndexRebuild } from "./commands/index-rebuild.js";
import { runDerivedConflictResolution } from "./commands/derived-conflicts.js";
import { runStale } from "./commands/stale.js";
import { runClaim } from "./commands/claim.js";
import { runPagesize } from "./commands/pagesize.js";
import { runLogRotate } from "./commands/log-rotate.js";
import { runLogAppend } from "./commands/log-append.js";
import { runLint } from "./commands/lint.js";
import { runHealth, type SyncMode } from "./commands/health.js";
import { runConfigGet, runConfigSet, runConfigList, runConfigPath } from "./commands/config.js";
import { runDoctor } from "./commands/doctor.js";
import { runArchive } from "./commands/archive.js";
import { runRemove } from "./commands/remove.js";
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
import { runSessionBrief } from "./commands/session-brief.js";
import { runMemoryImport, runMemoryIndex, runMemoryRecall, runMemoryReview, runMemoryTopics } from "./commands/memory.js";
import { runIngest } from "./commands/ingest.js";
import { runTagSync } from "./commands/tag-sync.js";
import { runTagReconcile } from "./commands/tag-reconcile.js";
import { runPagePublish } from "./commands/page-publish.js";
import { runSyncStatus, runSyncPush, runSyncPull, runSyncLock, runSyncUnlock, runSyncPeers, runSyncLintDelta } from "./commands/sync.js";
import { getCliSessionId } from "./utils/sync-lock.js";
import { runBackupSync, runBackupRestore } from "./commands/backup.js";
import { runStatus } from "./commands/status.js";
import { runSeed } from "./commands/seed.js";
import { runCanvasGenerate } from "./commands/canvas.js";
import { runQuery } from "./commands/query.js";
import { runIndexLinkFormat } from "./commands/index-link-format.js";
import { runTopicMapCheck } from "./commands/topic-map-check.js";
import { loadFleetManifestAndHost, runFleetContext, runFleetValidate, snapshotterAliasForLocalHost } from "./commands/fleet.js";
import { runFleetHealth } from "./commands/fleet-health.js";
import { resolveRuntimePath } from "./utils/wiki-path.js";
import { postCommit } from "./utils/auto-commit.js";
import { triggerAutoUpdate } from "./utils/auto-update.js";
import { parseDotenvFile } from "./utils/dotenv.js";
import { configPath } from "./commands/config.js";
import { readCliPackageJson } from "./utils/package-info.js";
import { runSkillwikiMcpStdio } from "./mcp/server.js";
import { guardProtectedVaultWrite } from "./utils/protected-vault-write-guard.js";

const pkg = readCliPackageJson();

const program = new Command();
program.name("skillwiki").description("Deterministic helpers for CodeWiki skills").version(pkg.version);
program.option("--human", "render terminal-readable output instead of JSON");

async function emit<T>(r: { exitCode: number; result: Result<T> }, vault?: string, opts?: { postCommit?: boolean }): Promise<never> {
  if (program.opts().human) printHuman(r.result); else printJson(r.result);
  if (vault && opts?.postCommit !== false) await postCommit(vault, r.exitCode);
  process.exit(r.exitCode);
}

async function emitGuardedVaultWrite<T>(
  vault: string,
  command: string,
  run: () => Promise<{ exitCode: number; result: Result<T> }> | { exitCode: number; result: Result<T> },
  opts?: { postCommit?: boolean }
): Promise<never> {
  const guard = await guardProtectedVaultWrite({
    vault,
    command,
    env: process.env,
    home: process.env.HOME ?? "",
    cwd: process.cwd(),
    osHostname: process.env.HOSTNAME,
    user: process.env.USER,
  });
  if (guard.blocked) {
    return emit({ exitCode: guard.exitCode, result: guard.result }, undefined, { postCommit: false });
  }
  return emit(await run(), vault, opts);
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
    if (opts.apply && vault) {
      return emitGuardedVaultWrite(vault, "validate --apply", () => runValidate({ file, apply: true, vault }), undefined);
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
    return emitGuardedVaultWrite(vault, "graph build", () => runGraphBuild({ vault, out }));
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
    else return emitGuardedVaultWrite(v.vault, "canvas generate", () => runCanvasGenerate({ vault: v.vault, graphPath: opts.graphPath }));
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
    wiki: opts.wiki,
    cwd: process.cwd(),
  })));

program.command("audit <file>").description("audit citation markers and source provenance for a vault page").action(async (file) => emit(await runAudit({ file })));

program
  .command("install")
  .description("install skillwiki SKILL.md files into ~/.claude/skills/")
  .option("--target <dir>", "target install directory", `${process.env.HOME ?? ""}/.claude/skills/`)
  .option("--dry-run", "preview only", false)
  .option("--skills-root <dir>", "source skills directory (defaults to packaged)")
  .option("--symlink", "create symlinks instead of copies (dev mode — edits to source are immediately visible)", false)
  .option("--force", "install CLI copies even when the skillwiki@llm-wiki plugin channel is active", false)
  .action(async (opts) => {
    const skillsRoot = opts.skillsRoot ?? new URL("../skills/", import.meta.url).pathname;
    emit(await runInstall({ skillsRoot, target: opts.target, dryRun: !!opts.dryRun, symlink: !!opts.symlink, home: process.env.HOME ?? "", force: !!opts.force }));
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
      cwd: process.cwd(),
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
    wiki,
    cwd: process.cwd(),
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

const tagCmd = program.command("tag").description("manage the vault tag taxonomy");

tagCmd
  .command("reconcile [vault]")
  .description("preview or add prospective page tags to SCHEMA taxonomy")
  .requiredOption("--page <path>", "vault-relative typed page target")
  .option("--from <path>", "unpublished draft or existing page to read tags from")
  .option("--tags <csv>", "comma-separated prospective tags")
  .option("--reason <text>", "reconciliation comment reason")
  .option("--write", "write SCHEMA.md after successful preview", false)
  .option("--wiki <name>", "wiki profile name")
  .action(async (vault, opts) => {
    const resolved = await resolveVaultArg(vault, opts.wiki);
    if (!resolved.ok) return emit({ exitCode: resolved.exitCode, result: resolved.payload });
    const input = {
      vault: resolved.vault,
      page: opts.page,
      from: opts.from,
      tags: opts.tags?.split(",").map((tag: string) => tag.trim()).filter(Boolean),
      reason: opts.reason,
      write: !!opts.write,
    };
    if (!opts.write) return emit(await runTagReconcile(input), resolved.vault, { postCommit: false });
    return emitGuardedVaultWrite(
      resolved.vault,
      "tag reconcile",
      () => runTagReconcile(input),
      { postCommit: false },
    );
  });

const pageCmd = program.command("page").description("validate and publish typed vault pages");

pageCmd
  .command("publish <draft> [vault]")
  .description("preview or publish an unpublished typed-page draft")
  .requiredOption("--target <path>", "vault-relative typed page target")
  .option("--log-note <text>", "single-line publication log note")
  .option("--write", "publish SCHEMA, page, index, and log", false)
  .option("--wiki <name>", "wiki profile name")
  .action(async (draft, vault, opts) => {
    const resolved = await resolveVaultArg(vault, opts.wiki);
    if (!resolved.ok) return emit({ exitCode: resolved.exitCode, result: resolved.payload });
    const input = {
      vault: resolved.vault,
      draftPath: draft,
      target: opts.target,
      logNote: opts.logNote,
      write: !!opts.write,
    };
    if (!opts.write) return emit(await runPagePublish(input), resolved.vault, { postCommit: false });
    return emitGuardedVaultWrite(
      resolved.vault,
      "page publish",
      () => runPagePublish(input),
      { postCommit: false },
    );
  });

const indexCmd = program.command("index").description("root index projection and checks");
indexCmd
  .command("rebuild [vault]")
  .description("preview or write deterministic root index.md projection")
  .option("--write", "write projected index.md", false)
  .option("--wiki <name>", "wiki profile name")
  .action(async (vault, opts) => {
    const v = await resolveVaultArg(vault, opts.wiki);
    if (!v.ok) emit({ exitCode: v.exitCode, result: v.payload });
    else emit(await runIndexRebuild({ vault: v.vault, write: Boolean(opts.write) }), v.vault);
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
  .option("--force-scan", "infer kind/project from filename and content when frontmatter is missing", false)
  .option("--project <slug>", "scope to a single project")
  .option("--wiki <name>", "wiki profile name")
  .action(async (vault, opts) => {
    const v = await resolveVaultArg(vault, opts.wiki);
    if (!v.ok) emit({ exitCode: v.exitCode, result: v.payload });
    else if (opts.archive) return emitGuardedVaultWrite(
      v.vault,
      "stale --archive",
      () => runStale({ vault: v.vault, days: opts.days, archive: true, forceScan: !!opts.forceScan, project: opts.project })
    );
    else emit(await runStale({ vault: v.vault, days: opts.days, archive: false, forceScan: !!opts.forceScan, project: opts.project }), v.vault);
  });

program
  .command("claim <transcript> [vault]")
  .description("claim an unclaimed transcript by creating a work item with source: link")
  .option("--project <slug>", "project slug (overrides transcript frontmatter)")
  .option("--slug <slug>", "work-item slug (defaults to transcript filename without date/kind prefix)")
  .option("--wiki <name>", "wiki profile name")
  .action(async (transcript, vault, opts) => {
    const v = await resolveVaultArg(vault, opts.wiki);
    if (!v.ok) emit({ exitCode: v.exitCode, result: v.payload });
    else return emitGuardedVaultWrite(
      v.vault,
      "claim",
      () => runClaim({ vault: v.vault, transcript, project: opts.project, slug: opts.slug })
    );
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
    else if (opts.apply) return emitGuardedVaultWrite(
      v.vault,
      "log-rotate --apply",
      () => runLogRotate({ vault: v.vault, threshold: opts.threshold, apply: true })
    );
    else emit(await runLogRotate({ vault: v.vault, threshold: opts.threshold, apply: false }), v.vault);
  });

program
  .command("log-append [vault]")
  .description("append a single entry to the vault log under a short advisory lock")
  .requiredOption("--content <text>", "log entry text to append")
  .option("--wiki <name>", "wiki profile name")
  .action(async (vault, opts) => {
    const v = await resolveVaultArg(vault, opts.wiki);
    if (!v.ok) emit({ exitCode: v.exitCode, result: v.payload });
    else return emitGuardedVaultWrite(
      v.vault,
      "log-append",
      () => runLogAppend({ vault: v.vault, content: opts.content })
    );
  });

program
  .command("lint [vault]")
  .description("run all vault health checks")
  .option("--days <n>", "stale threshold", (s) => parseInt(s, 10), 90)
  .option("--lines <n>", "pagesize threshold", (s) => parseInt(s, 10), 200)
  .option("--log-threshold <n>", "log rotation threshold", (s) => parseInt(s, 10), 500)
  .option("--fix", "auto-fix supported lint violations")
  .option("--only <bucket>", "run only the specified lint bucket")
  .option("--summary", "emit bounded bucket counts instead of full item arrays", false)
  .option("--examples <n>", "example count per bucket in summary mode", (s) => parseInt(s, 10), 3)
  .option("--wiki <name>", "wiki profile name")
  .action(async (vault, opts) => {
    const v = await resolveVaultArg(vault, opts.wiki);
    if (!v.ok) emit({ exitCode: v.exitCode, result: v.payload });
    else if (opts.fix) return emitGuardedVaultWrite(
      v.vault,
      "lint --fix",
      () => runLint({
        vault: v.vault,
        source: vault ? "flag" : undefined,
        days: opts.days,
        lines: opts.lines,
        logThreshold: opts.logThreshold,
        fix: true,
        only: opts.only,
        summary: !!opts.summary,
        examplesLimit: opts.summary ? opts.examples : undefined,
      })
    );
    else if (opts.summary) emit(await runLint({
      vault: v.vault,
      source: vault ? "flag" : undefined,
      days: opts.days,
      lines: opts.lines,
      logThreshold: opts.logThreshold,
      fix: false,
      only: opts.only,
      summary: true,
      examplesLimit: opts.examples,
    }), v.vault);
    else emit(await runLint({
      vault: v.vault,
      source: vault ? "flag" : undefined,
      days: opts.days,
      lines: opts.lines,
      logThreshold: opts.logThreshold,
      fix: false,
      only: opts.only,
    }), v.vault);
  });

program
  .command("health [vault]")
  .description("bounded whole-system wiki health report")
  .option("--wiki <name>", "wiki profile name")
  .option("--sync <mode>", "vault-sync policy: optional|required|off", "optional")
  .option("--no-fail", "always exit 0 while reporting status in JSON")
  .option("--out <path>", "write JSON result envelope to this path")
  .option("--examples <n>", "example count per lint bucket", (s) => parseInt(s, 10), 3)
  .action(async (vault, opts) => {
    const sync = String(opts.sync ?? "optional") as SyncMode;
    if (!["optional", "required", "off"].includes(sync)) {
      emit({ exitCode: ExitCode.USAGE, result: { ok: false, error: "USAGE", detail: "--sync must be optional, required, or off" } });
    }
    const v = await resolveVaultArg(vault, opts.wiki);
    if (!v.ok) emit({ exitCode: v.exitCode, result: v.payload });
    else emit(await runHealth({
      vault: v.vault,
      vaultSource: vault ? "flag" : "resolved",
      home: process.env.HOME ?? "",
      envValue: process.env.WIKI_PATH,
      argv: process.argv,
      currentVersion: pkg.version,
      cwd: process.cwd(),
      sync,
      noFail: opts.fail === false,
      out: opts.out,
      examplesLimit: opts.examples,
    }), undefined, { postCommit: false });
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
  .option("--check-snapshotter", "SSH-probe fleet snapshotter (short timeout)", false)
  .action(async (opts) => emit(await runDoctor({
    home: process.env.HOME ?? "",
    envValue: process.env.WIKI_PATH,
    argv: process.argv,
    currentVersion: pkg.version,
    cwd: process.cwd(),
    checkSnapshotter: !!opts.checkSnapshotter,
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
  .option("--cascade", "scan vault for references (wikilinks + sources arrays); preview by default", false)
  .option("--apply", "with --cascade: mutate sources arrays and archive (without --apply, --cascade is preview-only)", false)
  .option("--remote <remote>", "rclone remote root to prune the archived source path, for example seaweed-wiki:cloud/wiki")
  .option("--remote-delete", "delete the archived source path from the remote after local archive", false)
  .option("--max-remote-deletes <n>", "maximum remote object deletes allowed", "1")
  .action(async (page, vault, opts) => {
    const v = await resolveVaultArg(vault, opts.wiki);
    if (!v.ok) emit({ exitCode: v.exitCode, result: v.payload });
    else if (opts.cascade && !opts.apply) emit(await runArchive({
      vault: v.vault,
      page,
      cascade: true,
      apply: false,
      remote: opts.remote,
      remoteDelete: !!opts.remoteDelete,
      maxRemoteDeletes: Number.parseInt(opts.maxRemoteDeletes, 10),
    }), v.vault);
    else return emitGuardedVaultWrite(
      v.vault,
      "archive",
      () => runArchive({
        vault: v.vault,
        page,
        cascade: !!opts.cascade,
        apply: !!opts.apply,
        remote: opts.remote,
        remoteDelete: !!opts.remoteDelete,
        maxRemoteDeletes: Number.parseInt(opts.maxRemoteDeletes, 10),
      })
    );
  });

// remove (hard delete + delete-intent tombstone)
program
  .command("remove <page> [vault]")
  .description("remove a vault path and write a delete-intent tombstone")
  .option("--wiki <name>", "wiki profile name")
  .option("--remote <remote>", "rclone remote root to prune the live path, for example seaweed-wiki:cloud/wiki")
  .option("--remote-delete", "delete the live path from the remote after local remove", false)
  .option("--max-remote-deletes <n>", "maximum remote object deletes allowed", "1")
  .option("--reason <text>", "stored on the delete-intent tombstone")
  .action(async (page, vault, opts) => {
    const v = await resolveVaultArg(vault, opts.wiki);
    if (!v.ok) emit({ exitCode: v.exitCode, result: v.payload });
    else return emitGuardedVaultWrite(
      v.vault,
      "remove",
      () => runRemove({
        vault: v.vault,
        page,
        remote: opts.remote,
        remoteDelete: !!opts.remoteDelete,
        maxRemoteDeletes: Number.parseInt(opts.maxRemoteDeletes, 10),
        reason: opts.reason,
      })
    );
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
    else if (opts.apply) return emitGuardedVaultWrite(
      v.vault,
      "drift --apply",
      () => runDrift({ vault: v.vault, apply: true, newSince: opts.new })
    );
    else emit(await runDrift({ vault: v.vault, apply: false, newSince: opts.new }), v.vault);
  });

// dedup
program
  .command("dedup [vault]")
  .description("detect duplicate raw sources by sha256")
  .option("--apply", "rewire citations and remove duplicate raw files", false)
  .option("--canonical-policy <policy>", "canonical policy: stable-path or scan-order", "stable-path")
  .option("--manifest-out <path>", "write raw dedup delete manifest before applying")
  .option("--manifest-in <path>", "read existing raw dedup delete manifest for remote pruning")
  .option("--remote <remote>", "rclone remote root, for example seaweed-wiki:cloud/wiki")
  .option("--remote-delete", "delete manifest duplicate paths from the remote", false)
  .option("--max-remote-deletes <n>", "maximum remote object deletes allowed", "50")
  .option("--wiki <name>", "wiki profile name")
  .action(async (vault, opts) => {
    const v = await resolveVaultArg(vault, opts.wiki);
    if (!v.ok) emit({ exitCode: v.exitCode, result: v.payload });
    else if (opts.apply || opts.manifestOut) return emitGuardedVaultWrite(
      v.vault,
      opts.apply ? "dedup --apply" : "dedup --manifest-out",
      () => runDedup({
        vault: v.vault,
        apply: opts.apply,
        canonicalPolicy: opts.canonicalPolicy,
        manifestOut: opts.manifestOut,
        manifestIn: opts.manifestIn,
        remote: opts.remote,
        remoteDelete: !!opts.remoteDelete,
        maxRemoteDeletes: Number.parseInt(opts.maxRemoteDeletes, 10),
      })
    );
    else emit(await runDedup({
      vault: v.vault,
      apply: opts.apply,
      canonicalPolicy: opts.canonicalPolicy,
      manifestOut: opts.manifestOut,
      manifestIn: opts.manifestIn,
      remote: opts.remote,
      remoteDelete: !!opts.remoteDelete,
      maxRemoteDeletes: Number.parseInt(opts.maxRemoteDeletes, 10),
    }), v.vault);
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
    else if (opts.dryRun) emit(await runMigrateCitations({ vault: v.vault, dryRun: true }), v.vault);
    else return emitGuardedVaultWrite(
      v.vault,
      "migrate-citations",
      () => runMigrateCitations({ vault: v.vault, dryRun: false })
    );
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
    else if (opts.dryRun) emit(await runFrontmatterFix({ vault: v.vault, dryRun: true }), v.vault);
    else return emitGuardedVaultWrite(
      v.vault,
      "frontmatter-fix",
      () => runFrontmatterFix({ vault: v.vault, dryRun: false })
    );
  });

// update
program
  .command("update")
  .description("update skillwiki CLI from npm dist-tag")
  .option("--tag <tag>", "npm dist-tag", "latest")
  .action(async (opts) => emit(await runUpdate({
    home: process.env.HOME ?? "",
    distTag: opts.tag,
  })));

// self-update
program
  .command("self-update")
  .description("update skillwiki CLI from local source or npm dist-tag")
  .option("--check", "check for updates without installing", false)
  .option("--tag <tag>", "npm dist-tag", "latest")
  .action(async (opts) => emit(await runSelfUpdate({
    home: process.env.HOME ?? "",
    check: !!opts.check,
    distTag: opts.tag,
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
    else if (opts.apply) return emitGuardedVaultWrite(
      v.vault,
      "project-index --apply",
      () => runProjectIndex({ vault: v.vault, slug, apply: true })
    );
    else emit(await runProjectIndex({ vault: v.vault, slug, apply: false }), v.vault);
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
    else if (opts.dryRun) emit(await runCompound({ vault: v.vault, project: opts.project, dryRun: true }), v.vault);
    else return emitGuardedVaultWrite(
      v.vault,
      "compound promote",
      () => runCompound({ vault: v.vault, project: opts.project, dryRun: false })
    );
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
    else return emitGuardedVaultWrite(
      v.vault,
      "compound delete",
      () => runCompoundDelete({ vault: v.vault, project: opts.project, entry })
    );
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
    else if (opts.dryRun) emit(await runTagSync({ vault: v.vault, dryRun: true }), v.vault);
    else return emitGuardedVaultWrite(
      v.vault,
      "tag-sync",
      () => runTagSync({ vault: v.vault, dryRun: false })
    );
  });

// sync — grouped under a parent command
const syncCmd = program.command("sync").description("manage vault sync");

syncCmd
  .command("status [vault]")
  .description("check vault git sync status")
  .option("--wiki <name>", "wiki profile name")
  .option("--include-stashes", "enumerate all stashes in output", false)
  .option("--include-remote-health", "probe GitHub/S3 reachability (opt-in; adds network latency)", false)
  .option("--check-snapshotter", "with --include-remote-health, also SSH-probe fleet snapshotter alias", false)
  .action(async (vault, opts) => {
    const v = await resolveVaultArg(vault, opts.wiki);
    if (!v.ok) emit({ exitCode: v.exitCode, result: v.payload });
    else {
      const home = process.env.HOME ?? "";
      let snapshotterAlias: string | undefined;
      if (opts.checkSnapshotter) {
        const fleetLoad = await loadFleetManifestAndHost({
          vault: v.vault,
          home,
          cwd: process.cwd(),
        });
        snapshotterAlias = snapshotterAliasForLocalHost(fleetLoad);
      }
      emit(runSyncStatus({
        vault: v.vault,
        includeStashes: !!opts.includeStashes,
        includeRemoteHealth: !!opts.includeRemoteHealth,
        home,
        checkSnapshotter: !!opts.checkSnapshotter,
        snapshotterAlias,
      }));
    }
  });

syncCmd
  .command("push [vault]")
  .description("lint, commit, and push vault changes to remote")
  .option("--wiki <name>", "wiki profile name")
  .action(async (vault, opts) => {
    const v = await resolveVaultArg(vault, opts.wiki);
    if (!v.ok) emit({ exitCode: v.exitCode, result: v.payload });
    else return emitGuardedVaultWrite(
      v.vault,
      "sync push",
      () => runSyncPush({ vault: v.vault })
    );
  });

syncCmd
  .command("pull [vault]")
  .description("pull remote vault changes and lint")
  .option("--wiki <name>", "wiki profile name")
  .action(async (vault, opts) => {
    const v = await resolveVaultArg(vault, opts.wiki);
    if (!v.ok) emit({ exitCode: v.exitCode, result: v.payload });
    else return emitGuardedVaultWrite(
      v.vault,
      "sync pull",
      () => runSyncPull({ vault: v.vault })
    );
  });

syncCmd
  .command("resolve-derived [vault]")
  .description("resolve mixed derived conflicts for an owned vault-sync operation (internal)")
  .requiredOption("--operation-id <id>", "vault-sync operation journal id")
  .option("--wiki <name>", "wiki profile name")
  .action(async (vault, opts) => {
    const v = await resolveVaultArg(vault, opts.wiki);
    if (!v.ok) emit({ exitCode: v.exitCode, result: v.payload });
    else {
      return emitGuardedVaultWrite(
        v.vault,
        "sync resolve-derived",
        () => runDerivedConflictResolution({ vault: v.vault, operationId: opts.operationId }),
      );
    }
  });

syncCmd
  .command("lock [vault]")
  .description("acquire advisory lock on vault")
  .option("--summary <text>", "lock description", "skillwiki sync")
  .option("--ttl-minutes <n>", "lock time-to-live in minutes", "30")
  .option("--force", "overwrite existing lock", false)
  .option("--wiki <name>", "wiki profile name")
  .action(async (vault, opts) => {
    const v = await resolveVaultArg(vault, opts.wiki);
    if (!v.ok) emit({ exitCode: v.exitCode, result: v.payload });
    else {
      const ttl = parseInt(opts.ttlMinutes, 10) || 30;
      return emitGuardedVaultWrite(
        v.vault,
        "sync lock",
        async () => runSyncLock({ vault: v.vault, summary: opts.summary, ttlMinutes: ttl, force: !!opts.force, sessionId: getCliSessionId() })
      );
    }
  });

syncCmd
  .command("unlock [vault]")
  .description("release advisory lock on vault")
  .option("--force", "release lock regardless of holder", false)
  .option("--wiki <name>", "wiki profile name")
  .action(async (vault, opts) => {
    const v = await resolveVaultArg(vault, opts.wiki);
    if (!v.ok) emit({ exitCode: v.exitCode, result: v.payload });
    else return emitGuardedVaultWrite(
      v.vault,
      "sync unlock",
      async () => runSyncUnlock({ vault: v.vault, force: !!opts.force, sessionId: getCliSessionId() })
    );
  });

syncCmd
  .command("peers [vault]")
  .description("list active locks and recent wiki-sync stashes")
  .option("--wiki <name>", "wiki profile name")
  .action(async (vault, opts) => {
    const v = await resolveVaultArg(vault, opts.wiki);
    if (!v.ok) emit({ exitCode: v.exitCode, result: v.payload });
    else emit(runSyncPeers({ vault: v.vault, sessionId: getCliSessionId() }));
  });

syncCmd
  .command("lint-delta [vault]")
  .description("compare lint errors against a base ref; block only on new errors")
  .option("--base-ref <ref>", "base git ref to compare against", "origin/main")
  .option("--wiki <name>", "wiki profile name")
  .action(async (vault, opts) => {
    const v = await resolveVaultArg(vault, opts.wiki);
    if (!v.ok) emit({ exitCode: v.exitCode, result: v.payload });
    else emit(await runSyncLintDelta({ vault: v.vault, baseRef: opts.baseRef }));
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
    if (!v.ok) { emit({ exitCode: v.exitCode, result: v.payload }); return; }
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
    if (!v.ok) { emit({ exitCode: v.exitCode, result: v.payload }); return; }
    const home = process.env.HOME ?? process.env.USERPROFILE ?? "/tmp";
    const dotenv = await parseDotenvFile(configPath(home));
    return emitGuardedVaultWrite(
      v.vault,
      "backup restore",
      () => runBackupRestore({
        vault: v.vault,
        bucket: opts.bucket ?? dotenv["BACKUP_BUCKET"] ?? "",
        endpoint: opts.endpoint ?? dotenv["BACKUP_ENDPOINT"] ?? "",
        region: opts.region ?? dotenv["BACKUP_REGION"] ?? "us-east-1",
        accessKeyId: dotenv["BACKUP_ACCESS_KEY_ID"] ?? "",
        secretAccessKey: dotenv["BACKUP_SECRET_ACCESS_KEY"] ?? "",
        target: opts.target,
      })
    );
  });

// seed
program
  .command("seed [vault]")
  .description("populate a vault with example content")
  .option("--wiki <name>", "wiki profile name")
  .action(async (vault, opts) => {
    const v = await resolveVaultArg(vault, opts.wiki);
    if (!v.ok) emit({ exitCode: v.exitCode, result: v.payload });
    else return emitGuardedVaultWrite(
      v.vault,
      "seed",
      () => runSeed({ vault: v.vault })
    );
  });

// observe
program
  .command("observe [vault]")
  .description("create a raw transcript observation entry")
  .requiredOption("--text <text>", "observation text")
  .option("--kind <kind>", "observation kind (note|bug|task|idea|session-log)", "task")
  .option("--project <slug>", "associated project slug (required for task/bug claim detection)")
  .option("--wiki <name>", "wiki profile name")
  .action(async (vault, opts) => {
    const v = await resolveVaultArg(vault, opts.wiki);
    if (!v.ok) emit({ exitCode: v.exitCode, result: v.payload });
    else return emitGuardedVaultWrite(
      v.vault,
      "observe",
      () => runObserve({
        vault: v.vault,
        text: opts.text,
        kind: opts.kind,
        project: opts.project
      })
    );
  });

// session-brief
program
  .command("session-brief [vault]")
  .description("render or refresh the bounded startup session brief")
  .option("--project <slug>", "project slug, or auto for deterministic detection", "auto")
  .option("--write", "write meta/latest-session-brief.md and local cache files", false)
  .option("--wiki <name>", "wiki profile name")
  .action(async (vault, opts) => {
    const v = await resolveVaultArg(vault, opts.wiki);
    if (!v.ok) emit({ exitCode: v.exitCode, result: v.payload });
    else if (opts.write) return emitGuardedVaultWrite(
      v.vault,
      "session-brief --write",
      () => runSessionBrief({
        vault: v.vault,
        project: opts.project,
        write: true,
        cwd: process.cwd(),
        env: { SKILLWIKI_PROJECT: process.env.SKILLWIKI_PROJECT }
      }),
      { postCommit: true }
    );
    else emit(await runSessionBrief({
      vault: v.vault,
      project: opts.project,
      write: false,
      cwd: process.cwd(),
      env: { SKILLWIKI_PROJECT: process.env.SKILLWIKI_PROJECT }
    }), v.vault, { postCommit: false });
  });

const memoryCmd = program.command("memory").description("inspect derived agent memory caches");

memoryCmd
  .command("topics [vault]")
  .description("list topic-oriented memory from the optional derived cache")
  .option("--project <slug>", "filter topics by project slug")
  .option("--limit <n>", "maximum topics to return", (s) => parseInt(s, 10), 10)
  .option("--wiki <name>", "wiki profile name")
  .action(async (vault, opts) => {
    const v = await resolveVaultArg(vault, opts.wiki);
    if (!v.ok) emit({ exitCode: v.exitCode, result: v.payload });
    else emit(await runMemoryTopics({
      vault: v.vault,
      project: opts.project,
      limit: opts.limit,
    }), v.vault, { postCommit: false });
  });

memoryCmd
  .command("index [vault]")
  .description("build the derived project memory topic cache")
  .requiredOption("--project <slug>", "project slug")
  .option("--check", "report whether the local project memory cache is missing or stale without writing", false)
  .option("--if-stale", "rebuild the local project memory cache only when it is missing or stale", false)
  .option("--wiki <name>", "wiki profile name")
  .action(async (vault, opts) => {
    const v = await resolveVaultArg(vault, opts.wiki);
    if (!v.ok) emit({ exitCode: v.exitCode, result: v.payload });
    else if (opts.check) emit(await runMemoryIndex({
      vault: v.vault,
      project: opts.project,
      check: true,
      ifStale: !!opts.ifStale,
    }), v.vault, { postCommit: false });
    else return emitGuardedVaultWrite(
      v.vault,
      opts.ifStale ? "memory index --if-stale" : "memory index",
      () => runMemoryIndex({
        vault: v.vault,
        project: opts.project,
        check: false,
        ifStale: !!opts.ifStale,
      }),
      { postCommit: true }
    );
  });

memoryCmd
  .command("recall [vault]")
  .description("recall bounded source summaries for a memory topic")
  .requiredOption("--project <slug>", "project slug")
  .requiredOption("--topic <slug>", "memory topic slug")
  .option("--scope <scope>", "memory scope: project, global, cross-agent, or all")
  .option("--limit <n>", "maximum sources to return", (s) => parseInt(s, 10), 10)
  .option("--wiki <name>", "wiki profile name")
  .action(async (vault, opts) => {
    const v = await resolveVaultArg(vault, opts.wiki);
    if (!v.ok) emit({ exitCode: v.exitCode, result: v.payload });
    else emit(await runMemoryRecall({
      vault: v.vault,
      project: opts.project,
      topic: opts.topic,
      scope: opts.scope,
      limit: opts.limit,
    }), v.vault, { postCommit: false });
  });

memoryCmd
  .command("review [vault]")
  .description("review deterministic memory gaps and cache drift without writing")
  .requiredOption("--project <slug>", "project slug")
  .option("--dry-run", "preview only; writes are not supported on this surface", false)
  .option("--pre-action <target>", "target slug, file path, command, or error signature to check against past failure memory")
  .option("--wiki <name>", "wiki profile name")
  .action(async (vault, opts) => {
    const v = await resolveVaultArg(vault, opts.wiki);
    if (!v.ok) emit({ exitCode: v.exitCode, result: v.payload });
    else emit(await runMemoryReview({
      vault: v.vault,
      project: opts.project,
      dryRun: !!opts.dryRun,
      preAction: opts.preAction,
    }), v.vault, { postCommit: false });
  });

memoryCmd
  .command("import [vault]")
  .description("preview or apply local memory imports into raw captures")
  .requiredOption("--from <path>", "source file or directory to scan")
  .requiredOption("--project <slug>", "project slug")
  .option("--dry-run", "preview only; do not write captures", false)
  .option("--apply", "write validated raw captures for ready entries", false)
  .option("--max-bytes <n>", "reject source files above this size", (s) => parseInt(s, 10), 200000)
  .option("--wiki <name>", "wiki profile name")
  .action(async (vault, opts) => {
    const v = await resolveVaultArg(vault, opts.wiki);
    if (!v.ok) emit({ exitCode: v.exitCode, result: v.payload });
    else if (!!opts.apply && !opts.dryRun) return emitGuardedVaultWrite(
      v.vault,
      "memory import --apply",
      () => runMemoryImport({
        vault: v.vault,
        from: opts.from,
        project: opts.project,
        apply: true,
        maxBytes: opts.maxBytes,
      }),
      { postCommit: true }
    );
    else emit(await runMemoryImport({
      vault: v.vault,
      from: opts.from,
      project: opts.project,
      apply: false,
      maxBytes: opts.maxBytes,
    }), v.vault, { postCommit: false });
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
    if (opts.dryRun) {
      emit(await runIngest({
        source,
        vault: opts.vault,
        type: opts.type,
        title: opts.title,
        tags,
        provenance: opts.provenance,
        dryRun: true,
      }), opts.vault);
      return;
    }
    return emitGuardedVaultWrite(
      opts.vault,
      "ingest",
      () => runIngest({
        source,
        vault: opts.vault,
        type: opts.type,
        title: opts.title,
        tags,
        provenance: opts.provenance,
        dryRun: false,
      })
    );
  });

const fleetCmd = program.command("fleet").description("manage fleet topology metadata");

fleetCmd
  .command("validate <file>")
  .description("validate a fleet manifest")
  .action(async (file) => {
    emit(await runFleetValidate({ file }));
  });

fleetCmd
  .command("context [vault]")
  .description("render compact Runtime Host Context for SessionStart")
  .option("--file <path>", "fleet manifest path")
  .option("--host-id <id>", "explicit current fleet host id")
  .action(async (vault, opts) => {
    emit(await runFleetContext({
      vault,
      file: opts.file,
      hostId: opts.hostId,
      env: process.env,
      home: process.env.HOME ?? "",
      cwd: process.cwd(),
      osHostname: process.env.HOSTNAME,
      user: process.env.USER,
    }));
  });

fleetCmd
  .command("health [vault]")
  .description("read-only health probe for skillwiki satellite hosts")
  .option("--file <path>", "fleet manifest path")
  .option("--host-id <id>", "explicit current fleet host id")
  .option("--json", "emit JSON result")
  .action(async (vault, opts) => {
    const r = await runFleetHealth({
      vault,
      file: opts.file,
      hostId: opts.hostId,
      json: !!opts.json,
      env: process.env,
      home: process.env.HOME ?? "",
      cwd: process.cwd(),
      osHostname: process.env.HOSTNAME,
      user: process.env.USER,
    });
    emit(r, vault);
  });

// Emit deprecation warnings for any installed skills marked deprecated
program
  .command("mcp")
  .description("start stdio Model Context Protocol server (read-only vault tools)")
  .action(async () => {
    await runSkillwikiMcpStdio();
  });

for (const w of getDeprecatedWarnings(process.env.HOME ?? "")) {
  process.stderr.write(w + "\n");
}

// Background auto-update check (non-blocking, 24h cache)
triggerAutoUpdate(process.env.HOME ?? "", pkg.version);

program.parseAsync(process.argv).catch((e) => {
  process.stdout.write(JSON.stringify({ ok: false, error: "INTERNAL", detail: { message: String(e) } }) + "\n");
  process.exit(ExitCode.INTERNAL_ERROR);
});
