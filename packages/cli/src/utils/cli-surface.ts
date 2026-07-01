import { Command } from "commander";

export interface CliRefViolation {
  page: string;
  ref: string;
  reason: "unknown_command" | "unknown_flag";
}

/**
 * Build a parallel Commander program with all commands and options registered
 * (no action handlers) and extract the CLI surface as a map of
 * dot-separated command keys -> valid long flag names.
 *
 * Command keys: "stale", "graph", "graph.build", "sync", "sync.status", etc.
 * Flag values: "--archive", "--days", "--wiki", etc. (including inherited --human from root)
 */
export function buildCliSurface(): Map<string, Set<string>> {
  const program = new Command();
  program.name("skillwiki");
  program.option("--human", "render terminal-readable output instead of JSON");

  // Top-level commands with options
  program.command("hash");
  program.command("fetch-guard");
  program.command("validate").option("--apply").option("--vault <dir>").option("--wiki <name>");
  program.command("graph"); // has subcommands
  program.command("canvas"); // has subcommands
  program.command("overlap").option("--wiki <name>");
  program.command("query").option("--limit <n>").option("--wiki <name>");
  program.command("orphans").option("--wiki <name>");
  program.command("audit");
  program.command("install").option("--target <dir>").option("--dry-run").option("--skills-root <dir>").option("--symlink");
  program.command("path").option("--vault <dir>").option("--target <dir>").option("--wiki <name>").option("--init-time").option("--explain");
  program.command("lang").option("--lang <code>").option("--explain");
  program.command("init").option("--target <dir>").requiredOption("--domain <text>").option("--taxonomy <csv>").option("--lang <code>").option("--force").option("--no-env").option("--profile <name>");
  program.command("links").option("--wiki <name>");
  program.command("tag-audit").option("--wiki <name>");
  program.command("index-check").option("--wiki <name>");
  program.command("index-link-format").option("--wiki <name>");
  program.command("topic-map-check").option("--threshold <n>").option("--wiki <name>");
  program.command("stale").option("--archive").option("--days <n>").option("--force-scan").option("--project <slug>").option("--wiki <name>");
  program.command("claim").option("--project <slug>").option("--slug <slug>").option("--wiki <name>");
  program.command("pagesize").option("--lines <n>").option("--wiki <name>");
  program.command("log-rotate").option("--threshold <n>").option("--apply").option("--wiki <name>");
  program.command("log-append").requiredOption("--content <text>").option("--wiki <name>");
  program.command("lint").option("--days <n>").option("--lines <n>").option("--log-threshold <n>").option("--fix").option("--only <bucket>").option("--summary").option("--examples <n>").option("--wiki <name>");
  program.command("config"); // has subcommands
  program.command("health").option("--wiki <name>").option("--sync <mode>").option("--no-fail").option("--out <path>").option("--examples <n>");
  program.command("doctor");
  program.command("status").option("--wiki <name>");
  program.command("archive").option("--wiki <name>").option("--cascade").option("--apply");
  program.command("drift").option("--apply").option("--new <date>").option("--wiki <name>");
  program.command("dedup")
    .option("--apply")
    .option("--canonical-policy <policy>")
    .option("--manifest-out <path>")
    .option("--manifest-in <path>")
    .option("--remote <remote>")
    .option("--remote-delete")
    .option("--max-remote-deletes <n>")
    .option("--wiki <name>");
  program.command("migrate-citations").option("--dry-run").option("--wiki <name>");
  program.command("frontmatter-fix").option("--dry-run").option("--wiki <name>");
  program.command("update").option("--tag <tag>");
  program.command("self-update").option("--check");
  program.command("transcripts").option("--since <date>").option("--wiki <name>");
  program.command("project-index").option("--apply").option("--wiki <name>");
  program.command("compound"); // has subcommands
  program.command("tag-sync").option("--dry-run").option("--wiki <name>");
  program.command("sync"); // has subcommands
  program.command("backup"); // has subcommands
  program.command("seed").option("--wiki <name>");
  program.command("observe").requiredOption("--text <text>").option("--kind <kind>").option("--project <slug>").option("--wiki <name>");
  program.command("session-brief").option("--project <slug>").option("--write").option("--wiki <name>");
  program.command("memory"); // has subcommands
  program.command("ingest").requiredOption("--vault <path>").requiredOption("--type <type>").requiredOption("--title <title>").option("--tags <csv>").option("--provenance <provenance>").option("--dry-run");
  program.command("fleet"); // has subcommands

  // Subcommands
  const graphCmd = program.commands.find(c => c.name() === "graph")!;
  graphCmd.command("build").option("--out <path>").option("--wiki <name>");

  const canvasCmd = program.commands.find(c => c.name() === "canvas")!;
  canvasCmd.command("generate").option("--graph-path <path>").option("--wiki <name>");

  const configCmd = program.commands.find(c => c.name() === "config")!;
  configCmd.command("get");
  configCmd.command("set");
  configCmd.command("list").option("--profiles");
  configCmd.command("path");

  const compoundCmd = program.commands.find(c => c.name() === "compound")!;
  compoundCmd.command("promote").requiredOption("--project <slug>").option("--dry-run").option("--wiki <name>");
  compoundCmd.command("list").requiredOption("--project <slug>").option("--wiki <name>");
  compoundCmd.command("delete").requiredOption("--project <slug>").option("--wiki <name>");

  const syncCmd = program.commands.find(c => c.name() === "sync")!;
  syncCmd.command("status").option("--wiki <name>").option("--include-stashes");
  syncCmd.command("push").option("--wiki <name>");
  syncCmd.command("pull").option("--wiki <name>");
  syncCmd.command("lock").option("--summary <text>").option("--ttl-minutes <n>").option("--force").option("--wiki <name>");
  syncCmd.command("unlock").option("--force").option("--wiki <name>");
  syncCmd.command("peers").option("--wiki <name>");

  const backupCmd = program.commands.find(c => c.name() === "backup")!;
  backupCmd.command("sync").option("--dry-run").option("--bucket <name>").option("--endpoint <url>").option("--region <region>").option("--prune").option("--wiki <name>");
  backupCmd.command("restore").option("--bucket <name>").option("--endpoint <url>").option("--region <region>").option("--target <dir>").option("--wiki <name>");

  const memoryCmd = program.commands.find(c => c.name() === "memory")!;
  memoryCmd.command("topics").option("--project <slug>").option("--limit <n>").option("--wiki <name>");
  memoryCmd.command("index").requiredOption("--project <slug>").option("--check").option("--if-stale").option("--wiki <name>");
  memoryCmd.command("recall").requiredOption("--project <slug>").requiredOption("--topic <slug>").option("--scope <scope>").option("--limit <n>").option("--wiki <name>");
  memoryCmd.command("review").requiredOption("--project <slug>").option("--dry-run").option("--pre-action <target>").option("--wiki <name>");
  memoryCmd.command("import").requiredOption("--from <path>").requiredOption("--project <slug>").option("--dry-run").option("--apply").option("--max-bytes <n>").option("--wiki <name>");

  const fleetCmd = program.commands.find(c => c.name() === "fleet")!;
  fleetCmd.command("validate");
  fleetCmd.command("context").option("--file <path>").option("--host-id <id>");

  // Extract surface map
  const surface = new Map<string, Set<string>>();

  // Root flags (--human applies to all commands)
  const rootFlags = new Set(program.options.map(o => o.long ?? o.short).filter((f): f is string => f != null));

  function walk(cmd: Command, prefix: string, parentFlags: Set<string>) {
    const key = prefix ? `${prefix}.${cmd.name()}` : cmd.name();
    const flags = new Set([...parentFlags, ...cmd.options.map(o => o.long ?? o.short).filter((f): f is string => f != null)]);
    surface.set(key, flags);
    for (const sub of cmd.commands) {
      walk(sub, key, flags);
    }
  }

  for (const cmd of program.commands) {
    walk(cmd, "", rootFlags);
  }

  return surface;
}

/**
 * Regex for backtick-wrapped skillwiki CLI references.
 * Matches: `skillwiki <cmd> [--<flag> ...]`
 * Does NOT match prose like "skillwiki also provides" (no backticks).
 */
const CLI_REF_RE = /`skillwiki\s+([a-z][a-z0-9-]*(?:\s+[a-z][a-z0-9-]*)?)((?:\s+--[a-z][a-z0-9-]*(?:\s+(?!--)\S+)?)*)`/g;

/**
 * Validate CLI references in a vault page's text content.
 * Returns an array of violations for unknown commands or flags.
 */
export function validateCliRefs(text: string, page: string, surface: Map<string, Set<string>>): CliRefViolation[] {
  const violations: CliRefViolation[] = [];

  // Build a set of all command keys and a set of parent command keys (for subcommand matching)
  const allKeys = new Set(surface.keys());
  const parentKeys = new Set<string>();
  for (const key of allKeys) {
    const dotIdx = key.indexOf(".");
    if (dotIdx >= 0) parentKeys.add(key.slice(0, dotIdx));
  }

  for (const match of text.matchAll(CLI_REF_RE)) {
    const fullMatch = match[0]!;
    const cmdPart = match[1]!;
    // Extract all --flag tokens from the full match
    const flagTokens = [...fullMatch.matchAll(/--([a-z][a-z0-9-]*)/g)].map(m => `--${m[1]!}`);

    // Resolve command key: check two-word combos first (for subcommands)
    const words = cmdPart.split(/\s+/);
    let resolvedKey: string | undefined;

    if (words.length >= 2) {
      const twoWordKey = `${words[0]!}.${words[1]!}`;
      if (allKeys.has(twoWordKey)) {
        resolvedKey = twoWordKey;
      }
    }

    if (!resolvedKey) {
      // When the user wrote a two-word ref like `skillwiki sync deploy`
      // and "sync.deploy" is not a known subcommand, check whether the parent
      // "sync" is itself a parent command (has subcommands).  If it does, the
      // second word was intended as a subcommand that does not exist — flag it.
      if (words.length >= 2) {
        const oneWordKey = words[0]!;
        const parentHasSubcommands = [...allKeys].some(k => k.startsWith(oneWordKey + "."));
        if (parentHasSubcommands) {
          violations.push({ page, ref: fullMatch.replace(/^`|`$/g, ""), reason: "unknown_command" });
          continue;
        }
      }

      const oneWordKey = words[0]!;
      if (allKeys.has(oneWordKey)) {
        resolvedKey = oneWordKey;
      }
    }

    if (!resolvedKey) {
      violations.push({ page, ref: fullMatch.replace(/^`|`$/g, ""), reason: "unknown_command" });
      continue;
    }

    // Validate flags
    const validFlags = surface.get(resolvedKey)!;
    // Also include parent command flags for subcommands
    const dotIdx = resolvedKey.indexOf(".");
    let allValidFlags = validFlags;
    if (dotIdx >= 0) {
      const parentKey = resolvedKey.slice(0, dotIdx);
      const parentFlags = surface.get(parentKey);
      if (parentFlags) {
        allValidFlags = new Set([...validFlags, ...parentFlags]);
      }
    }

    for (const flag of flagTokens) {
      if (!allValidFlags.has(flag)) {
        violations.push({ page, ref: fullMatch.replace(/^`|`$/g, ""), reason: "unknown_flag" });
      }
    }
  }

  return violations;
}
