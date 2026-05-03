import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { ok, err, ExitCode, type Result } from "@skillwiki/shared";
import { resolveInitTimePath } from "../utils/wiki-path.js";
import { resolveLang } from "../utils/lang.js";
import { parseDotenvFile } from "../utils/dotenv.js";

const DEFAULT_TAXONOMY = [
  "research", "comparison", "timeline", "summary", "person",
  "organization", "concept", "technique", "tool", "model"
];

const VAULT_DIRS = [
  "raw/articles", "raw/papers", "raw/transcripts", "raw/assets",
  "entities", "concepts", "comparisons", "queries", "meta", "projects"
];

export interface InitInput {
  flag: string | undefined;
  envValue: string | undefined;
  home: string;
  templates: string;
  domain: string;
  taxonomy: string[] | undefined;
  lang: string | undefined;
  force: boolean;
}

export interface InitOutput {
  vault: string;
  domain: string;
  taxonomy: string[];
  lang: string;
  created: string[];
  env_written: string;
  imported_from_hermes: boolean;
}

export async function runInit(input: InitInput): Promise<{ exitCode: number; result: Result<InitOutput> }> {
  const pathRes = await resolveInitTimePath({ flag: input.flag, envValue: input.envValue, home: input.home });
  const target = pathRes.path;

  const langRes = await resolveLang({ flag: input.lang, envValue: undefined, home: input.home });
  const canonicalLang = langRes.canonical;

  let hasSchema = false;
  try { await stat(join(target, "SCHEMA.md")); hasSchema = true; } catch { /* good */ }
  if (hasSchema && !input.force) {
    return {
      exitCode: ExitCode.INIT_TARGET_NOT_EMPTY,
      result: err("INIT_TARGET_NOT_EMPTY", { target })
    };
  }

  const envPath = join(input.home, ".skillwiki", ".env");
  const existingEnv = await parseDotenvFile(envPath);
  const swDotenvHadPath = existingEnv.WIKI_PATH !== undefined;
  if (existingEnv.WIKI_PATH !== undefined && existingEnv.WIKI_PATH !== target && !input.force) {
    return {
      exitCode: ExitCode.ENV_WRITE_CONFLICT,
      result: err("ENV_WRITE_CONFLICT", { key: "WIKI_PATH", existing: existingEnv.WIKI_PATH, attempted: target })
    };
  }
  if (existingEnv.WIKI_LANG !== undefined && existingEnv.WIKI_LANG !== canonicalLang && !input.force) {
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
  const taxonomy = input.taxonomy && input.taxonomy.length > 0 ? input.taxonomy : DEFAULT_TAXONOMY;
  const taxonomyYaml = taxonomy.map(t => `  - ${t}`).join("\n");

  try {
    const schemaTpl = await readFile(join(input.templates, "SCHEMA.md"), "utf8");
    const schema = schemaTpl
      .replace("{{DOMAIN}}", input.domain)
      .replace("{{WIKI_LANG}}", canonicalLang)
      .replace("{{TAXONOMY_YAML}}", taxonomyYaml);
    await writeFile(join(target, "SCHEMA.md"), schema, "utf8");
    created.push("SCHEMA.md");
  } catch (e) {
    return { exitCode: ExitCode.WRITE_FAILED, result: err("WRITE_FAILED", { file: "SCHEMA.md", message: String(e) }) };
  }

  try {
    const idxTpl = await readFile(join(input.templates, "index.md"), "utf8");
    const idx = idxTpl.replace("{{INIT_DATE}}", today);
    await writeFile(join(target, "index.md"), idx, "utf8");
    created.push("index.md");
  } catch (e) {
    return { exitCode: ExitCode.WRITE_FAILED, result: err("WRITE_FAILED", { file: "index.md", message: String(e) }) };
  }

  try {
    const logTpl = await readFile(join(input.templates, "log.md"), "utf8");
    const log = logTpl
      .replace(/\{\{INIT_DATE\}\}/g, today)
      .replace("{{DOMAIN}}", input.domain)
      .replace("{{WIKI_LANG}}", canonicalLang);
    await writeFile(join(target, "log.md"), log, "utf8");
    created.push("log.md");
  } catch (e) {
    return { exitCode: ExitCode.WRITE_FAILED, result: err("WRITE_FAILED", { file: "log.md", message: String(e) }) };
  }

  try {
    await mkdir(dirname(envPath), { recursive: true });
    const envBody = `WIKI_PATH=${target}\nWIKI_LANG=${canonicalLang}\n`;
    await writeFile(envPath, envBody, "utf8");
  } catch (e) {
    return { exitCode: ExitCode.WRITE_FAILED, result: err("WRITE_FAILED", { file: envPath, message: String(e) }) };
  }

  const importedFromHermes = pathRes.source === "hermes-dotenv" && !swDotenvHadPath;

  return {
    exitCode: ExitCode.OK,
    result: ok({
      vault: target,
      domain: input.domain,
      taxonomy,
      lang: canonicalLang,
      created,
      env_written: envPath,
      imported_from_hermes: importedFromHermes
    })
  };
}
