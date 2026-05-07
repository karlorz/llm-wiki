import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { ok, err, ExitCode, type Result } from "@skillwiki/shared";
import { resolveInitTimePath } from "../utils/wiki-path.js";
import { resolveLang } from "../utils/lang.js";
import { parseDotenvText, writeDotenv, profileKey, type DotenvMap } from "../utils/dotenv.js";
import { extractTaxonomy } from "../parsers/taxonomy.js";
import { extractFrontmatter } from "../parsers/frontmatter.js";

const DEFAULT_TAXONOMY = [
  "research", "comparison", "timeline", "summary", "person",
  "organization", "concept", "technique", "tool", "model"
];

const VAULT_DIRS = [
  "raw/articles", "raw/papers", "raw/transcripts", "raw/assets",
  "entities", "concepts", "comparisons", "queries", "meta", "projects",
  ".obsidian"
];

const ATTACHMENT_FOLDER = "raw/assets";

export interface InitInput {
  flag: string | undefined;
  envValue: string | undefined;
  home: string;
  templates: string;
  domain: string;
  taxonomy: string[] | undefined;
  lang: string | undefined;
  force: boolean;
  noEnv?: boolean;
  profile?: string;
}

export interface InitOutput {
  vault: string;
  domain: string;
  taxonomy: string[];
  lang: string;
  created: string[];
  preserved: string[];
  env_written: string;
  env_skipped: boolean;
  imported_from_hermes: boolean;
  discovered_tags: number;
  humanHint: string;
}

function extractDomainFromSchema(text: string): string {
  const m = text.match(/^##\s+Domain\s*\n([\s\S]*?)(?=\n\n|\n##|\s*$)/m);
  if (!m) return "";
  const d = m[1].trim();
  return d.startsWith("##") ? "" : d;
}

async function discoverTagsFromPages(target: string, knownSlugs: string[]): Promise<string[]> {
  const knownSet = new Set(knownSlugs);
  const discovered = new Set<string>();
  for (const dir of ["entities", "concepts", "comparisons", "queries"]) {
    let entries: string[];
    try {
      entries = (await readdir(join(target, dir), { withFileTypes: true }))
        .filter(e => e.isFile() && e.name.endsWith(".md"))
        .map(e => e.name);
    } catch { continue; }
    for (const file of entries) {
      try {
        const text = await readFile(join(target, dir, file), "utf8");
        const fm = extractFrontmatter(text);
        if (!fm.ok || !fm.data.tags || !Array.isArray(fm.data.tags)) continue;
        for (const t of fm.data.tags) {
          if (typeof t === "string" && !knownSet.has(t)) discovered.add(t);
        }
      } catch { /* skip unreadable files */ }
    }
  }
  return [...discovered].sort();
}

export async function runInit(input: InitInput): Promise<{ exitCode: number; result: Result<InitOutput> }> {
  const pathRes = await resolveInitTimePath({ flag: input.flag, envValue: input.envValue, home: input.home });
  const target = pathRes.path;

  const langRes = await resolveLang({ flag: input.lang, envValue: undefined, home: input.home });
  const canonicalLang = langRes.canonical;

  let oldSchemaText: string | undefined;
  try { oldSchemaText = await readFile(join(target, "SCHEMA.md"), "utf8"); } catch { /* no existing schema */ }
  if (oldSchemaText && !input.force) {
    return {
      exitCode: ExitCode.INIT_TARGET_NOT_EMPTY,
      result: err("INIT_TARGET_NOT_EMPTY", { target })
    };
  }

  const envPath = join(input.home, ".skillwiki", ".env");
  let existingEnvRaw = "";
  try { existingEnvRaw = await readFile(envPath, "utf8"); } catch { /* new file */ }
  const existingEnv = parseDotenvText(existingEnvRaw);
  const swDotenvHadPath = existingEnv.WIKI_PATH !== undefined;
  if (!input.profile && existingEnv.WIKI_PATH !== undefined && existingEnv.WIKI_PATH !== target && !input.force) {
    return {
      exitCode: ExitCode.ENV_WRITE_CONFLICT,
      result: err("ENV_WRITE_CONFLICT", { key: "WIKI_PATH", existing: existingEnv.WIKI_PATH, attempted: target })
    };
  }
  if (!input.profile && existingEnv.WIKI_LANG !== undefined && existingEnv.WIKI_LANG !== canonicalLang && !input.force) {
    return {
      exitCode: ExitCode.ENV_WRITE_CONFLICT,
      result: err("ENV_WRITE_CONFLICT", { key: "WIKI_LANG", existing: existingEnv.WIKI_LANG, attempted: canonicalLang })
    };
  }

  const created: string[] = [];

  try {
    await mkdir(target, { recursive: true });
    for (const d of VAULT_DIRS) {
      await mkdir(join(target, d), { recursive: true });
      created.push(d + "/");
    }
  } catch (e) {
    return { exitCode: ExitCode.WRITE_FAILED, result: err("WRITE_FAILED", { message: String(e) }) };
  }

  const today = new Date().toISOString().slice(0, 10);
  let taxonomy = input.taxonomy && input.taxonomy.length > 0 ? input.taxonomy : DEFAULT_TAXONOMY;
  let domain = input.domain;

  // SCHEMA.md migration — read old domain and taxonomy from existing SCHEMA.md
  let oldTaxonomy: string[] = [];
  if (oldSchemaText) {
    if (!domain) {
      const oldDomain = extractDomainFromSchema(oldSchemaText);
      if (oldDomain) domain = oldDomain;
    }
    const oldTax = extractTaxonomy(oldSchemaText);
    if (oldTax.ok) oldTaxonomy = oldTax.data;
  }

  const taxonomySet = new Set(taxonomy);
  for (const t of oldTaxonomy) {
    if (!taxonomySet.has(t)) { taxonomy.push(t); taxonomySet.add(t); }
  }


  const discovered = await discoverTagsFromPages(target, taxonomy);
  const discovered_tags = discovered.length;

  const fullTaxonomyYaml = discovered.length > 0
    ? taxonomy.map(t => `  - ${t}`).join("\n")
      + "\n  # --- Discovered from existing pages ---\n"
      + discovered.map(t => `  - ${t}`).join("\n")
    : taxonomy.map(t => `  - ${t}`).join("\n");

  try {
    const schemaTpl = await readFile(join(input.templates, "SCHEMA.md"), "utf8");
    const schema = schemaTpl
      .replace("{{DOMAIN}}", domain)
      .replace("{{WIKI_LANG}}", canonicalLang)
      .replace("{{TAXONOMY_YAML}}", fullTaxonomyYaml);
    await writeFile(join(target, "SCHEMA.md"), schema, "utf8");
    created.push("SCHEMA.md");
  } catch (e) {
    return { exitCode: ExitCode.WRITE_FAILED, result: err("WRITE_FAILED", { file: "SCHEMA.md", message: String(e) }) };
  }

  const preserved: string[] = [];

  async function writeOrPreserve(
    fileName: string, render: () => Promise<string>
  ): Promise<{ exitCode: number; result: Result<InitOutput> } | undefined> {
    try {
      const existing = await readFile(join(target, fileName), "utf8");
      if (existing.split("\n").length > 10) { preserved.push(fileName); return undefined; }
    } catch { /* no existing file */ }
    try {
      await writeFile(join(target, fileName), await render(), "utf8");
      created.push(fileName);
      return undefined;
    } catch (e) {
      return { exitCode: ExitCode.WRITE_FAILED, result: err("WRITE_FAILED", { file: fileName, message: String(e) }) };
    }
  }

  const err1 = await writeOrPreserve("index.md", async () => {
    const tpl = await readFile(join(input.templates, "index.md"), "utf8");
    return tpl.replace("{{INIT_DATE}}", today);
  });
  if (err1) return err1;

  const errObsidian = await writeOrPreserve(".obsidian/app.json", async () => {
    return JSON.stringify({ attachmentFolderPath: ATTACHMENT_FOLDER }, null, 2) + "\n";
  });
  if (errObsidian) return errObsidian;

  const err2 = await writeOrPreserve("log.md", async () => {
    const tpl = await readFile(join(input.templates, "log.md"), "utf8");
    return tpl.replace(/\{\{INIT_DATE\}\}/g, today).replace("{{DOMAIN}}", domain).replace("{{WIKI_LANG}}", canonicalLang);
  });
  if (err2) return err2;

  const skipEnv = !!input.noEnv;
  let envWritten = "";
  if (!skipEnv) {
    try {
      const envEntries: DotenvMap = {};
      if (input.profile) {
        envEntries[profileKey(input.profile, "PATH")] = target;
        envEntries[profileKey(input.profile, "LANG")] = canonicalLang;
        envEntries["WIKI_DEFAULT"] = input.profile;
      } else {
        envEntries["WIKI_PATH"] = target;
        envEntries["WIKI_LANG"] = canonicalLang;
      }
      await writeDotenv(envPath, envEntries, existingEnvRaw);
      envWritten = envPath;
    } catch (e) {
      return { exitCode: ExitCode.WRITE_FAILED, result: err("WRITE_FAILED", { file: envPath, message: String(e) }) };
    }
  }

  const importedFromHermes = pathRes.source === "hermes-dotenv" && !swDotenvHadPath;

  const humanHint = [
    `vault: ${target}`,
    `domain: ${domain}`,
    `lang: ${canonicalLang}`,
    `created: ${created.length}, preserved: ${preserved.length}`,
    `discovered tags: ${discovered_tags}`,
    skipEnv ? "env: skipped" : `env: ${envWritten}`,
  ].join("\n");

  return {
    exitCode: ExitCode.OK,
    result: ok({
      vault: target,
      domain,
      taxonomy,
      lang: canonicalLang,
      created,
      preserved,
      env_written: envWritten,
      env_skipped: skipEnv,
      imported_from_hermes: importedFromHermes,
      discovered_tags,
      humanHint
    })
  };
}
