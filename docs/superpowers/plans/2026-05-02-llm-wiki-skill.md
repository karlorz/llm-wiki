# CodeWiki Skill Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the `skillwiki` npm package + 10 Claude Code skills that build and maintain project-aware Karpathy-style markdown knowledge bases, wire-compatible with Hermes llm-wiki v2.1.0.

**Architecture:** npm workspaces monorepo. `packages/cli` (TypeScript) ships the `skillwiki` binary with 8 deterministic subcommands. `packages/skills` holds 10 SKILL.md files (6 `wiki-*` + 4 `proj-*`) — prompt-only Markdown that calls `skillwiki` for data work. `packages/shared` is reserved for v1.2 MCP server. Built with tsup, validated with Zod, tested with Vitest.

**Tech Stack:** TypeScript 5.7+, Node ≥20, tsup, Commander, Zod, js-yaml, Vitest, Markdown (Obsidian-flavored).

**Reference Documents:**
- Spec: `docs/superpowers/specs/2026-05-02-llm-wiki-skill-design.md` (canonical)
- Hermes contract: `raw/hermes-llm-wiki-SKILL-v2.1.0.md`
- Toolchain reference: `https://github.com/atomicmemory/llm-wiki-compiler`

**Phase Overview (each phase ends shippable):**
| Phase | Output |
|---|---|
| 0 | Repo bootstrap: workspaces + tooling configured |
| 1 | `skillwiki` v0.1.0 — `hash`, `fetch-guard`, `validate` subcommands |
| 2 | `skillwiki` v0.2.0 — `graph build`, `overlap`, `orphans`, `audit` subcommands |
| 3 | `skillwiki` v0.3.0 — `install` (cross-platform skills installer) |
| 4 | Templates: SCHEMA.md, index.md, log.md, project-README.md |
| 5 | 6 `wiki-*` SKILL.md files complete |
| 6 | 4 `proj-*` SKILL.md files complete |
| 7 | Integration tests, docs, CI, npm publish |

**Note:** This plan covers Phases 0–1 in detail (TDD-style). Phases 2–7 are scaffolded with task structure and reference the spec; full code-level steps for those phases will be expanded inline by the executing engineer following the same TDD pattern shown in Phase 1, or split into follow-up plan files if scope demands. The current spec is large enough that a single plan file at full granularity would exceed practical bounds; ship Phase 1 first, then re-plan from there.

---

## File Structure

| File | Responsibility |
|------|---------------|
| `package.json` | Root workspaces config |
| `packages/cli/package.json` | `name: "skillwiki"`, `bin: { skillwiki: dist/cli.js }` |
| `packages/cli/src/cli.ts` | Commander entry; routes to subcommand modules |
| `packages/cli/src/commands/hash.ts` | sha256 of body bytes |
| `packages/cli/src/commands/fetch-guard.ts` | URL validation + secret strip |
| `packages/cli/src/commands/validate.ts` | Frontmatter validation via Zod |
| `packages/cli/src/commands/graph.ts` | Wikilink adjacency + Adamic-Adar |
| `packages/cli/src/commands/overlap.ts` | Source-overlap clusters (E2 4.0×) |
| `packages/cli/src/commands/orphans.ts` | Orphan + bridge node detection |
| `packages/cli/src/commands/audit.ts` | `^[raw/...]` resolution + sources↔body |
| `packages/cli/src/commands/install.ts` | Atomic skill copy + manifest |
| `packages/cli/src/schema/{typed-knowledge,raw,work-item,compound}.ts` | Zod schemas |
| `packages/cli/src/parsers/{frontmatter,wikilinks,citations}.ts` | Markdown parsers |
| `packages/cli/src/utils/{paths,hash}.ts` | Utilities |
| `packages/skills/<10 dirs>/SKILL.md` | Prompt-only skills |
| `templates/{SCHEMA,index,log,project-README}.md` | Vault templates |

---

## Phase 0: Repo Bootstrap

### Task 0.1: Initialize npm workspaces monorepo

**Files:**
- Create: `package.json`, `.gitignore`, `.nvmrc`

- [ ] **Step 1: Create root package.json**

```json
{
  "name": "llm-wiki-monorepo",
  "private": true,
  "version": "0.1.0",
  "description": "skillwiki CLI + Claude Code skills for project-aware Karpathy-style wikis",
  "workspaces": ["packages/cli", "packages/skills", "packages/shared"],
  "engines": { "node": ">=20" },
  "scripts": {
    "build": "npm run build --workspace packages/cli",
    "test": "npm run test --workspace packages/cli"
  },
  "license": "MIT"
}
```

- [ ] **Step 2: Create .gitignore**

```gitignore
node_modules/
dist/
*.log
.env
.DS_Store
coverage/
```

- [ ] **Step 3: Create .nvmrc**

```
20
```

- [ ] **Step 4: Verify and commit**

```bash
node --version  # must be >= 20
git add package.json .gitignore .nvmrc
git commit -m "chore: initialize npm workspaces monorepo"
```

---

### Task 0.2: Scaffold packages/cli with TypeScript + tsup

**Files:**
- Create: `packages/cli/package.json`, `tsconfig.json`, `tsup.config.ts`, `src/cli.ts`

- [ ] **Step 1: Create packages/cli/package.json**

```json
{
  "name": "skillwiki",
  "version": "0.1.0",
  "description": "Deterministic CLI utilities for project-aware Karpathy LLM Wikis",
  "type": "module",
  "bin": { "skillwiki": "dist/cli.js" },
  "main": "dist/cli.js",
  "files": ["dist/", "README.md", "LICENSE"],
  "scripts": {
    "build": "tsup",
    "dev": "tsup --watch",
    "test": "vitest run",
    "test:watch": "vitest",
    "prepublishOnly": "npm run build && npm test"
  },
  "engines": { "node": ">=20" },
  "dependencies": {
    "commander": "^13.0.0",
    "js-yaml": "^4.1.0",
    "zod": "^3.25.0"
  },
  "devDependencies": {
    "@types/js-yaml": "^4.0.9",
    "@types/node": "^22.0.0",
    "tsup": "^8.0.0",
    "typescript": "^5.7.0",
    "vitest": "^3.0.0"
  },
  "license": "MIT"
}
```

- [ ] **Step 2: Create packages/cli/tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "outDir": "dist",
    "rootDir": "src",
    "declaration": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "test"]
}
```

- [ ] **Step 3: Create packages/cli/tsup.config.ts**

```typescript
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/cli.ts'],
  format: ['esm'],
  target: 'node20',
  outDir: 'dist',
  clean: true,
  splitting: false,
  sourcemap: true,
  banner: { js: '#!/usr/bin/env node' },
});
```

- [ ] **Step 4: Create placeholder src/cli.ts**

```typescript
import { Command } from 'commander';
const program = new Command();
program
  .name('skillwiki')
  .description('Deterministic CLI utilities for project-aware Karpathy LLM Wikis')
  .version('0.1.0');
program.parse();
```

- [ ] **Step 5: Install, build, smoke-test**

```bash
npm install
npm run build --workspace packages/cli
node packages/cli/dist/cli.js --version
```

Expected: prints `0.1.0`.

- [ ] **Step 6: Commit**

```bash
git add packages/cli package-lock.json
git commit -m "chore(cli): scaffold skillwiki package"
```

---

### Task 0.3: Add Vitest

**Files:**
- Create: `packages/cli/vitest.config.ts`, `packages/cli/test/smoke.test.ts`

- [ ] **Step 1: Create vitest.config.ts**

```typescript
import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    coverage: { provider: 'v8', reporter: ['text', 'lcov'] },
  },
});
```

- [ ] **Step 2: Create test/smoke.test.ts**

```typescript
import { describe, it, expect } from 'vitest';
describe('smoke', () => {
  it('runs', () => { expect(1 + 1).toBe(2); });
});
```

- [ ] **Step 3: Run tests**

```bash
npm test --workspace packages/cli
```

Expected: 1 passed.

- [ ] **Step 4: Commit**

```bash
git add packages/cli/vitest.config.ts packages/cli/test
git commit -m "test(cli): add Vitest with smoke test"
```

---

### Task 0.4: Scaffold packages/skills and packages/shared

**Files:**
- Create: `packages/skills/package.json`, `packages/skills/README.md`
- Create: `packages/shared/package.json`, `packages/shared/README.md`

- [ ] **Step 1: Create packages/skills/package.json**

```json
{
  "name": "@llm-wiki/skills",
  "version": "0.1.0",
  "private": true,
  "description": "Claude Code SKILL.md files for project-aware wiki maintenance",
  "license": "MIT"
}
```

- [ ] **Step 2: Create packages/skills/README.md**

```markdown
# @llm-wiki/skills

Claude Code skill definitions installed via `skillwiki install`.

10 skills, two namespaces:
- `wiki-init`, `wiki-ingest`, `wiki-query`, `wiki-lint`, `wiki-crystallize`, `wiki-audit`
- `proj-init`, `proj-work`, `proj-distill`, `proj-decide`
```

- [ ] **Step 3: Create packages/shared/package.json**

```json
{
  "name": "@llm-wiki/shared",
  "version": "0.1.0",
  "private": true,
  "description": "Shared types between skillwiki CLI and future MCP server",
  "type": "module",
  "license": "MIT"
}
```

- [ ] **Step 4: Create packages/shared/README.md**

```markdown
# @llm-wiki/shared
Reserved for v1.2 MCP server. Currently empty.
```

- [ ] **Step 5: Commit**

```bash
git add packages
git commit -m "chore: scaffold packages/skills and packages/shared"
```

---

## Phase 1: skillwiki CLI Core (hash, fetch-guard, validate)

### Task 1.1: Body-byte sha256 utility

**Files:**
- Create: `packages/cli/src/utils/hash.ts`, `packages/cli/test/utils/hash.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// packages/cli/test/utils/hash.test.ts
import { describe, it, expect } from 'vitest';
import { hashBodyBytes } from '../../src/utils/hash';

describe('hashBodyBytes', () => {
  it('returns 64-char hex digest', () => {
    expect(hashBodyBytes('---\nx: 1\n---\nbody\n')).toMatch(/^[a-f0-9]{64}$/);
  });
  it('hashes whole input when no frontmatter', () => {
    expect(hashBodyBytes('no frontmatter')).toMatch(/^[a-f0-9]{64}$/);
  });
  it('produces identical hash when only frontmatter differs', () => {
    const a = '---\ntitle: A\n---\nidentical\n';
    const b = '---\ntitle: B\nupdated: 2026-01-01\n---\nidentical\n';
    expect(hashBodyBytes(a)).toBe(hashBodyBytes(b));
  });
  it('treats CRLF and LF differently (no normalization)', () => {
    expect(hashBodyBytes('---\nx: 1\n---\nbody\n'))
      .not.toBe(hashBodyBytes('---\r\nx: 1\r\n---\r\nbody\r\n'));
  });
});
```

- [ ] **Step 2: Run, verify FAIL**

```bash
npm test --workspace packages/cli
```

Expected: FAIL — `hashBodyBytes` not exported.

- [ ] **Step 3: Implement**

```typescript
// packages/cli/src/utils/hash.ts
import { createHash } from 'node:crypto';

/**
 * Compute sha256 of body bytes after the closing `---` of YAML frontmatter.
 * No normalization. If no frontmatter present, hash entire input.
 */
export function hashBodyBytes(content: string): string {
  const body = extractBody(content);
  return createHash('sha256').update(body, 'utf8').digest('hex');
}

function extractBody(content: string): string {
  if (!content.startsWith('---\n')) return content;
  const closing = content.indexOf('\n---\n', 4);
  if (closing === -1) return content;
  return content.slice(closing + 5);
}
```

- [ ] **Step 4: Run tests, verify PASS**

```bash
npm test --workspace packages/cli
```

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/utils packages/cli/test/utils
git commit -m "feat(cli): hashBodyBytes — sha256 of body after frontmatter"
```

---

### Task 1.2: `skillwiki hash` subcommand

**Files:**
- Create: `packages/cli/src/commands/hash.ts`
- Modify: `packages/cli/src/cli.ts`
- Create: `packages/cli/test/commands/hash.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// packages/cli/test/commands/hash.test.ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hashCommand } from '../../src/commands/hash';

describe('hashCommand', () => {
  it('returns sha256 for given file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sw-'));
    const file = join(dir, 'sample.md');
    writeFileSync(file, '---\ntitle: x\n---\nhello\n');
    const result = await hashCommand(file);
    expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.file).toContain('sample.md');
  });
  it('throws on missing file', async () => {
    await expect(hashCommand('/nonexistent/x.md')).rejects.toThrow(/ENOENT/);
  });
});
```

- [ ] **Step 2: Run, verify FAIL**

- [ ] **Step 3: Implement command**

```typescript
// packages/cli/src/commands/hash.ts
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { hashBodyBytes } from '../utils/hash.js';

export interface HashResult {
  file: string;
  sha256: string;
}

export async function hashCommand(filePath: string): Promise<HashResult> {
  const abs = resolve(filePath);
  const content = await readFile(abs, 'utf8');
  return { file: abs, sha256: hashBodyBytes(content) };
}
```

- [ ] **Step 4: Wire into CLI**

Replace `packages/cli/src/cli.ts`:

```typescript
import { Command } from 'commander';
import { hashCommand } from './commands/hash.js';

const program = new Command();
program
  .name('skillwiki')
  .description('Deterministic CLI utilities for project-aware Karpathy LLM Wikis')
  .version('0.1.0');

program
  .command('hash')
  .description('Compute sha256 of body bytes after closing --- of frontmatter')
  .argument('<file>', 'path to markdown file')
  .option('--human', 'human-readable output')
  .action(async (file: string, opts: { human?: boolean }) => {
    const result = await hashCommand(file);
    if (opts.human) console.log(`${result.sha256}  ${result.file}`);
    else console.log(JSON.stringify(result));
  });

program.parseAsync().catch((err: Error) => {
  console.error(JSON.stringify({ error: err.message }));
  process.exit(1);
});
```

- [ ] **Step 5: Run tests + smoke**

```bash
npm test --workspace packages/cli
npm run build --workspace packages/cli
printf '%s' '---\ntitle: t\n---\nhello\n' > /tmp/x.md
node packages/cli/dist/cli.js hash /tmp/x.md
```

- [ ] **Step 6: Commit**

```bash
git add packages/cli
git commit -m "feat(cli): skillwiki hash subcommand"
```

---

### Task 1.3: `skillwiki fetch-guard` subcommand

**Files:**
- Create: `packages/cli/src/commands/fetch-guard.ts`
- Modify: `packages/cli/src/cli.ts`
- Create: `packages/cli/test/commands/fetch-guard.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// packages/cli/test/commands/fetch-guard.test.ts
import { describe, it, expect } from 'vitest';
import { fetchGuard } from '../../src/commands/fetch-guard';

describe('fetchGuard', () => {
  it('allows public https URL', () => {
    expect(fetchGuard('https://example.com/path').allowed).toBe(true);
  });
  it('blocks http (insecure scheme)', () => {
    const r = fetchGuard('http://example.com');
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/scheme/i);
  });
  it('blocks file:// scheme', () => {
    expect(fetchGuard('file:///etc/passwd').allowed).toBe(false);
  });
  it('blocks loopback (127.0.0.1)', () => {
    const r = fetchGuard('https://127.0.0.1/x');
    expect(r.allowed).toBe(false);
  });
  it('blocks RFC1918 (10.0.0.0/8)', () => {
    expect(fetchGuard('https://10.0.0.5/x').allowed).toBe(false);
  });
  it('blocks AWS metadata endpoint', () => {
    expect(fetchGuard('https://169.254.169.254/latest/').allowed).toBe(false);
  });
  it('strips api_key query param', () => {
    const r = fetchGuard('https://api.example.com/v1?api_key=secret&q=hi');
    expect(r.allowed).toBe(true);
    expect(r.stripped_url).not.toMatch(/secret/);
    expect(r.stripped_url).toMatch(/q=hi/);
  });
  it('rejects malformed URL', () => {
    expect(fetchGuard('not a url').allowed).toBe(false);
  });
});
```

- [ ] **Step 2: Run, verify FAIL**

- [ ] **Step 3: Implement**

```typescript
// packages/cli/src/commands/fetch-guard.ts
export interface FetchGuardResult {
  allowed: boolean;
  reason?: string;
  stripped_url?: string;
  url: string;
}

const SENSITIVE_QUERY_KEYS = new Set([
  'api_key', 'apikey', 'access_token', 'auth_token', 'token', 'key',
  'secret', 'password', 'passwd', 'authorization',
]);

export function fetchGuard(rawUrl: string): FetchGuardResult {
  let url: URL;
  try { url = new URL(rawUrl); }
  catch { return { allowed: false, reason: 'malformed URL', url: rawUrl }; }

  if (url.protocol !== 'https:') {
    return { allowed: false, reason: `scheme not allowed: ${url.protocol}`, url: rawUrl };
  }
  if (isPrivateHost(url.hostname)) {
    return { allowed: false, reason: `private/loopback/metadata host: ${url.hostname}`, url: rawUrl };
  }

  const stripped = new URL(url.toString());
  for (const key of [...stripped.searchParams.keys()]) {
    if (SENSITIVE_QUERY_KEYS.has(key.toLowerCase())) {
      stripped.searchParams.delete(key);
    }
  }
  stripped.username = '';
  stripped.password = '';

  return { allowed: true, stripped_url: stripped.toString(), url: rawUrl };
}

function isPrivateHost(hostname: string): boolean {
  const m = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a === 127) return true;
    if (a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    if (a === 0) return true;
  }
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) return true;
  if (hostname === 'metadata.google.internal') return true;
  return false;
}
```

- [ ] **Step 4: Wire into CLI** (add to cli.ts before `program.parseAsync()`):

```typescript
import { fetchGuard } from './commands/fetch-guard.js';

program
  .command('fetch-guard')
  .description('Validate a URL for safe fetch (blocks private IPs, strips secrets)')
  .argument('<url>', 'URL to validate')
  .option('--human', 'human-readable output')
  .action((url: string, opts: { human?: boolean }) => {
    const result = fetchGuard(url);
    if (opts.human) {
      console.log(result.allowed ? `OK ${result.stripped_url}` : `BLOCKED ${result.reason}`);
    } else {
      console.log(JSON.stringify(result));
    }
    if (!result.allowed) process.exit(2);
  });
```

- [ ] **Step 5: Run tests + smoke**

```bash
npm test --workspace packages/cli
npm run build --workspace packages/cli
node packages/cli/dist/cli.js fetch-guard https://example.com
node packages/cli/dist/cli.js fetch-guard https://127.0.0.1 || echo "blocked OK"
```

- [ ] **Step 6: Commit**

```bash
git add packages/cli
git commit -m "feat(cli): skillwiki fetch-guard (F1 security control)"
```

---

### Task 1.4: Frontmatter parser

**Files:**
- Create: `packages/cli/src/parsers/frontmatter.ts`, `packages/cli/test/parsers/frontmatter.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// packages/cli/test/parsers/frontmatter.test.ts
import { describe, it, expect } from 'vitest';
import { parseFrontmatter } from '../../src/parsers/frontmatter';

describe('parseFrontmatter', () => {
  it('extracts YAML object', () => {
    const r = parseFrontmatter('---\ntitle: Foo\ntags: [a, b]\n---\nbody');
    expect(r.data).toEqual({ title: 'Foo', tags: ['a', 'b'] });
    expect(r.body).toBe('body');
  });
  it('returns empty object when no frontmatter', () => {
    const r = parseFrontmatter('just body');
    expect(r.data).toEqual({});
    expect(r.body).toBe('just body');
  });
  it('throws on malformed YAML', () => {
    expect(() => parseFrontmatter('---\n: : :\n---\nx')).toThrow();
  });
});
```

- [ ] **Step 2: Run, verify FAIL**

- [ ] **Step 3: Implement**

```typescript
// packages/cli/src/parsers/frontmatter.ts
import { load } from 'js-yaml';

export interface ParsedFrontmatter {
  data: Record<string, unknown>;
  body: string;
}

export function parseFrontmatter(content: string): ParsedFrontmatter {
  if (!content.startsWith('---\n')) return { data: {}, body: content };
  const closing = content.indexOf('\n---\n', 4);
  if (closing === -1) return { data: {}, body: content };
  const yaml = content.slice(4, closing);
  const body = content.slice(closing + 5);
  const data = load(yaml) as Record<string, unknown> | null;
  return { data: data ?? {}, body };
}
```

- [ ] **Step 4: Run, verify PASS**

```bash
npm test --workspace packages/cli
```

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/parsers packages/cli/test/parsers
git commit -m "feat(cli): frontmatter parser"
```

---

### Task 1.5: Zod schemas (4 frontmatter shapes)

**Files:**
- Create: `packages/cli/src/schema/{typed-knowledge,raw,work-item,compound,index}.ts`
- Create: `packages/cli/test/schema/typed-knowledge.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// packages/cli/test/schema/typed-knowledge.test.ts
import { describe, it, expect } from 'vitest';
import { TypedKnowledgeSchema } from '../../src/schema/typed-knowledge';

const minimal = {
  title: 'Foo', created: '2026-05-03', updated: '2026-05-03',
  type: 'concept', tags: ['x'], sources: [],
};

describe('TypedKnowledgeSchema', () => {
  it('accepts minimal Hermes frontmatter', () => {
    expect(() => TypedKnowledgeSchema.parse(minimal)).not.toThrow();
  });
  it('accepts provenance: research', () => {
    expect(() => TypedKnowledgeSchema.parse({ ...minimal, provenance: 'research' })).not.toThrow();
  });
  it('requires provenance_projects when provenance: project', () => {
    expect(() => TypedKnowledgeSchema.parse({ ...minimal, provenance: 'project' }))
      .toThrow(/provenance_projects/);
  });
  it('requires provenance_projects when provenance: mixed', () => {
    expect(() => TypedKnowledgeSchema.parse({ ...minimal, provenance: 'mixed' }))
      .toThrow(/provenance_projects/);
  });
  it('rejects invalid type enum', () => {
    expect(() => TypedKnowledgeSchema.parse({ ...minimal, type: 'banana' })).toThrow();
  });
});
```

- [ ] **Step 2: Run, verify FAIL**

- [ ] **Step 3: Implement typed-knowledge schema**

```typescript
// packages/cli/src/schema/typed-knowledge.ts
import { z } from 'zod';
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');

export const TypedKnowledgeSchema = z.object({
  title: z.string().min(1),
  aliases: z.array(z.string()).optional(),
  created: isoDate,
  updated: isoDate,
  type: z.enum(['entity', 'concept', 'comparison', 'query', 'summary']),
  tags: z.array(z.string()),
  sources: z.array(z.string()),
  confidence: z.enum(['high', 'medium', 'low']).optional(),
  contested: z.boolean().optional(),
  contradictions: z.array(z.string()).optional(),
  provenance: z.enum(['research', 'project', 'mixed']).optional(),
  provenance_projects: z.array(z.string()).optional(),
  work_items: z.array(z.string()).optional(),
}).refine(
  (data) => {
    if (data.provenance === 'project' || data.provenance === 'mixed') {
      return Array.isArray(data.provenance_projects) && data.provenance_projects.length > 0;
    }
    return true;
  },
  { message: 'provenance_projects required when provenance is project or mixed', path: ['provenance_projects'] }
);

export type TypedKnowledge = z.infer<typeof TypedKnowledgeSchema>;
```

- [ ] **Step 4: Implement raw schema**

```typescript
// packages/cli/src/schema/raw.ts
import { z } from 'zod';
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const RawSchema = z.object({
  title: z.string().optional(),
  source_url: z.string().url().nullable().optional(),
  ingested: isoDate,
  ingested_by: z.enum(['wiki-ingest', 'proj-work', 'manual']).optional(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  project: z.string().optional(),
  work_item: z.string().optional(),
  kind: z.enum(['postmortem', 'session-log', 'meeting-notes', 'other']).optional(),
});
export type Raw = z.infer<typeof RawSchema>;
```

- [ ] **Step 5: Implement work-item schema**

```typescript
// packages/cli/src/schema/work-item.ts
import { z } from 'zod';
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const WorkItemSchema = z.object({
  title: z.string().min(1),
  aliases: z.array(z.string()).optional(),
  created: isoDate,
  updated: isoDate,
  started: isoDate.optional(),
  completed: isoDate.optional(),
  kind: z.enum(['feature', 'issue', 'refactor', 'decision']),
  status: z.enum(['planned', 'in-progress', 'completed', 'abandoned']),
  priority: z.enum(['high', 'medium', 'low']),
  project: z.string().min(1),
  owner: z.string().optional(),
  parent: z.string().optional(),
  related: z.array(z.string()).optional(),
  sources: z.array(z.string()).optional(),
});
export type WorkItem = z.infer<typeof WorkItemSchema>;
```

- [ ] **Step 6: Implement compound schema**

```typescript
// packages/cli/src/schema/compound.ts
import { z } from 'zod';
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const CompoundSchema = z.object({
  title: z.string().min(1),
  aliases: z.array(z.string()).optional(),
  created: isoDate,
  updated: isoDate,
  type: z.enum(['lesson', 'pattern', 'antipattern', 'gotcha']),
  tags: z.array(z.string()),
  confidence: z.enum(['high', 'medium', 'low']).optional(),
  contradicts: z.array(z.string()).optional(),
  project: z.string().min(1),
  work_items: z.array(z.string()).optional(),
  promoted_to: z.string().optional(),
  cssclasses: z.array(z.string()).optional(),
});
export type Compound = z.infer<typeof CompoundSchema>;
```

- [ ] **Step 7: Schema index**

```typescript
// packages/cli/src/schema/index.ts
export { TypedKnowledgeSchema, type TypedKnowledge } from './typed-knowledge.js';
export { RawSchema, type Raw } from './raw.js';
export { WorkItemSchema, type WorkItem } from './work-item.js';
export { CompoundSchema, type Compound } from './compound.js';
```

- [ ] **Step 8: Run tests + commit**

```bash
npm test --workspace packages/cli
git add packages/cli/src/schema packages/cli/test/schema
git commit -m "feat(cli): Zod schemas for 4 frontmatter shapes"
```

---

### Task 1.6: `skillwiki validate` subcommand

**Files:**
- Create: `packages/cli/src/commands/validate.ts`, `packages/cli/test/commands/validate.test.ts`
- Modify: `packages/cli/src/cli.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// packages/cli/test/commands/validate.test.ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateCommand } from '../../src/commands/validate';

const goodConcept = `---
title: Foo
created: 2026-05-03
updated: 2026-05-03
type: concept
tags: [x]
sources: []
---
body
`;

const badConcept = goodConcept.replace('type: concept', 'type: banana');

function setup(content: string, subdir: string, name: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'sw-'));
  mkdirSync(join(dir, subdir), { recursive: true });
  const file = join(dir, subdir, name);
  writeFileSync(file, content);
  return file;
}

describe('validateCommand', () => {
  it('reports valid for good typed-knowledge file', async () => {
    const f = setup(goodConcept, 'concepts', 'x.md');
    const r = await validateCommand(f);
    expect(r.valid).toBe(true);
    expect(r.errors).toHaveLength(0);
  });
  it('reports errors for invalid type enum', async () => {
    const f = setup(badConcept, 'concepts', 'x.md');
    const r = await validateCommand(f);
    expect(r.valid).toBe(false);
    expect(r.errors.length).toBeGreaterThan(0);
  });
  it('reports unknown schema for paths outside known folders', async () => {
    const f = setup(goodConcept, 'random', 'x.md');
    const r = await validateCommand(f);
    expect(r.schema).toBe('unknown');
    expect(r.valid).toBe(false);
  });
});
```

- [ ] **Step 2: Run, verify FAIL**

- [ ] **Step 3: Implement**

```typescript
// packages/cli/src/commands/validate.ts
import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { ZodError } from 'zod';
import { parseFrontmatter } from '../parsers/frontmatter.js';
import {
  TypedKnowledgeSchema, RawSchema, WorkItemSchema, CompoundSchema,
} from '../schema/index.js';

export interface ValidateResult {
  file: string;
  schema: 'typed-knowledge' | 'raw' | 'work-item' | 'compound' | 'unknown';
  valid: boolean;
  errors: { path: string; message: string }[];
}

export async function validateCommand(filePath: string): Promise<ValidateResult> {
  const abs = resolve(filePath);
  const content = await readFile(abs, 'utf8');
  const { data } = parseFrontmatter(content);
  const schema = inferSchemaFromPath(abs);

  if (schema === 'unknown') {
    return { file: abs, schema, valid: false, errors: [{ path: '', message: 'cannot infer schema from path' }] };
  }

  const map = {
    'typed-knowledge': TypedKnowledgeSchema,
    'raw': RawSchema,
    'work-item': WorkItemSchema,
    'compound': CompoundSchema,
  } as const;

  try {
    map[schema].parse(data);
    return { file: abs, schema, valid: true, errors: [] };
  } catch (err) {
    if (err instanceof ZodError) {
      return {
        file: abs, schema, valid: false,
        errors: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      };
    }
    throw err;
  }
}

function inferSchemaFromPath(abs: string): ValidateResult['schema'] {
  const norm = abs.split(sep).join('/');
  if (/\/raw\//.test(norm)) return 'raw';
  if (/\/projects\/[^/]+\/work\//.test(norm)) return 'work-item';
  if (/\/projects\/[^/]+\/compound\//.test(norm)) return 'compound';
  if (/\/(entities|concepts|comparisons|queries)\//.test(norm)) return 'typed-knowledge';
  return 'unknown';
}
```

- [ ] **Step 4: Wire into CLI** (add to cli.ts):

```typescript
import { validateCommand } from './commands/validate.js';

program
  .command('validate')
  .description('Validate frontmatter against the appropriate Zod schema (inferred from path)')
  .argument('<file>', 'path to markdown file')
  .option('--human', 'human-readable output')
  .action(async (file: string, opts: { human?: boolean }) => {
    const result = await validateCommand(file);
    if (opts.human) {
      console.log(result.valid ? `OK ${result.schema} ${result.file}` : `INVALID ${result.schema} ${result.file}`);
      for (const e of result.errors) console.log(`  ${e.path}: ${e.message}`);
    } else {
      console.log(JSON.stringify(result));
    }
    if (!result.valid) process.exit(3);
  });
```

- [ ] **Step 5: Run tests + smoke + commit**

```bash
npm test --workspace packages/cli
npm run build --workspace packages/cli
git add packages/cli
git commit -m "feat(cli): skillwiki validate subcommand"
```

---

### Task 1.7: Phase 1 milestone — npm publish dry-run

- [ ] **Step 1: Verify all tests pass**

```bash
npm test --workspace packages/cli
```

- [ ] **Step 2: npm publish dry-run**

```bash
cd packages/cli
npm publish --dry-run --access public
cd ../..
```

Expected: lists files in `dist/` and shows package contents.

- [ ] **Step 3: Tag milestone**

```bash
git tag -a v0.1.0-alpha -m "Phase 1 milestone: skillwiki hash + fetch-guard + validate"
```

---

## Phase 2: Graph & Audit Subcommands

> **Note**: Phase 2 tasks follow the same TDD pattern as Phase 1 (write failing test → run → implement → verify → commit). Concrete code is sketched per task; expand into full Steps 1-N during execution.

### Task 2.1: Wikilink parser

**Files:**
- Create: `packages/cli/src/parsers/wikilinks.ts`
- Create: `packages/cli/test/parsers/wikilinks.test.ts`

**Behavior:**
- Extract `[[name]]` and `[[name|display]]` patterns from markdown body
- Skip code fences and inline code (regex respects `` ` `` and ``` ``` ``` ``` boundaries)
- Return list of unique target page slugs

**Test cases:**
- Single wikilink: `[[foo]]` → `['foo']`
- With display: `[[foo|bar]]` → `['foo']`
- Inside code fence: ignored
- Inside inline code: ignored
- Heading anchors: `[[foo#section]]` → `['foo']`
- Block refs: `[[foo#^block]]` → `['foo']`

**Implementation outline:**
```typescript
export function extractWikilinks(body: string): string[] {
  const stripped = stripCodeBlocks(body);
  const re = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g;
  const out = new Set<string>();
  for (const m of stripped.matchAll(re)) {
    if (m[1]) out.add(m[1].trim());
  }
  return [...out];
}
```

**Commit message:** `feat(cli): wikilink parser`

---

### Task 2.2: `skillwiki graph build` subcommand

**Files:**
- Create: `packages/cli/src/commands/graph.ts`
- Create: `packages/cli/test/commands/graph.test.ts`

**Behavior:**
- Walk vault directory, read every `.md` under `entities/`, `concepts/`, `comparisons/`, `queries/`, `projects/*/compound/`, `meta/`
- Parse wikilinks via Task 2.1's parser
- Build adjacency map: `{ slug: { outbound: [...], inbound: [...] } }`
- Compute Adamic-Adar score for each pair sharing a common neighbor: `AA(u, v) = Σ 1 / log(degree(w))` over shared neighbors w
- Emit JSON: `{ nodes: [...], edges: [...], adamic_adar: [[u, v, score], ...] }`

**CLI signature:** `skillwiki graph build <vault-path>`

**Test cases:**
- Three pages with linear chain `A → B → C`: adjacency correct
- A and C share common neighbor B: Adamic-Adar score is `1 / log(2)` (B has degree 2)
- Empty vault: returns `{ nodes: [], edges: [], adamic_adar: [] }`

**Commit message:** `feat(cli): skillwiki graph build subcommand`

---

### Task 2.3: `skillwiki overlap` subcommand

**Files:**
- Create: `packages/cli/src/commands/overlap.ts`
- Create: `packages/cli/test/commands/overlap.test.ts`

**Behavior:**
- Walk vault; read frontmatter `sources:` array from typed-knowledge pages
- Group pages that share ≥1 raw source path
- Emit clusters: `{ clusters: [{ source: 'raw/a.md', pages: ['p1', 'p2'] }, ...] }`

**CLI signature:** `skillwiki overlap <vault-path>`

**Test cases:**
- Two pages cite same raw source: appear in same cluster
- Three pages, transitive overlap (A↔B via X, B↔C via Y): two distinct cluster entries
- Pages with no overlap: not in any cluster

**Commit message:** `feat(cli): skillwiki overlap (E2 4.0× signal)`

---

### Task 2.4: `skillwiki orphans` subcommand

**Files:**
- Create: `packages/cli/src/commands/orphans.ts`
- Create: `packages/cli/test/commands/orphans.test.ts`

**Behavior:**
- Reuse graph build output (or recompute)
- Find connected components in undirected wikilink graph
- Report orphans (component size 1), small clusters (size 2-3), and bridge nodes (single articulation point connecting two else-disconnected components)
- Emit: `{ orphans: [...], small_clusters: [[...], ...], bridge_nodes: [{ slug, connects: [c1, c2] }] }`

**CLI signature:** `skillwiki orphans <vault-path>`

**Test cases:**
- Page with no inbound or outbound links: in `orphans`
- Two disconnected pairs: each in `small_clusters`
- One page connecting two clusters: in `bridge_nodes`

**Commit message:** `feat(cli): skillwiki orphans (E3 review queue)`

---

### Task 2.5: Citation parser

**Files:**
- Create: `packages/cli/src/parsers/citations.ts`
- Create: `packages/cli/test/parsers/citations.test.ts`

**Behavior:**
- Extract `^[raw/...]` markers from body (Hermes provenance markers)
- Extract numbered footnotes `[^N]` and their definitions `[^N]: ...`
- Skip code blocks
- Return: `{ provenance_markers: ['raw/articles/x.md', ...], footnotes: [{ id: '1', target: 'raw/...' | url, ... }] }`

**Test cases:**
- Paragraph ending with `^[raw/articles/x.md]`: extracted
- Multiple markers in one paragraph: all extracted
- Footnote `[^1]` with definition `[^1]: raw/...`: matched
- Footnote inside code: ignored

**Commit message:** `feat(cli): citation marker parser`

---

### Task 2.6: `skillwiki audit` subcommand

**Files:**
- Create: `packages/cli/src/commands/audit.ts`
- Create: `packages/cli/test/commands/audit.test.ts`

**Behavior:**
- Read target file's frontmatter `sources:` and body provenance markers
- For each `^[raw/...]` marker: verify file exists at `<vault-root>/raw/...`
- For each entry in `sources:`: verify it's referenced at least once in body (markers OR wikilinks)
- For pages with ≥3 sources: flag bare external URLs as "consider ingesting"
- Emit: `{ file, unresolved_markers: [...], unreferenced_sources: [...], suggest_ingest: [...] }`

**CLI signature:** `skillwiki audit <file>`

**Test cases:**
- File with valid markers and resolved files: empty unresolved
- File with `^[raw/missing.md]` marker but file absent: in unresolved
- `sources:` entry not referenced in body: in unreferenced_sources
- 3+ sources page with bare `https://example.com`: in suggest_ingest

**Commit message:** `feat(cli): skillwiki audit subcommand`

---

### Task 2.7: Phase 2 milestone

- [ ] **Step 1**: Run `npm test --workspace packages/cli` — all green
- [ ] **Step 2**: Bump `packages/cli/package.json` version to `0.2.0`
- [ ] **Step 3**: Update `program.version('0.2.0')` in `cli.ts`
- [ ] **Step 4**: `npm publish --dry-run --access public` from `packages/cli`
- [ ] **Step 5**: `git tag v0.2.0-alpha`

---

## Phase 3: `skillwiki install` Subcommand

### Task 3.1: Cross-platform skills installer

**Files:**
- Create: `packages/cli/src/commands/install.ts`
- Create: `packages/cli/test/commands/install.test.ts`

**Behavior:**
- Locate target `~/.claude/skills/` (override via `--target <path>` for tests)
- For each skill directory in `packages/skills/`: atomic copy to target
- If target skill already exists: back up to `<target>.bak-<timestamp>` first
- Write manifest at `<target>/wiki-manifest.json`: `{ installed: [{ name, version, path, sha256 }, ...], installed_at: ISO }`
- Idempotent: re-run with same source produces no diff (verify via manifest sha256)

**Failure modes:**
- Target path not writable → exit 4 with reason
- Disk full mid-copy → roll back partial copies, restore backups

**CLI signature:** `skillwiki install [--target <path>] [--source <path>] [--dry-run]`

**Test cases:**
- Fresh install into empty target: all skills copied, manifest written
- Re-install: backups created, new files written, manifest updated
- `--dry-run`: prints planned operations, no writes
- Target unwritable: exit 4

**Commit message:** `feat(cli): skillwiki install (cross-platform installer F4)`

---

### Task 3.2: Phase 3 milestone

- [ ] **Step 1**: All tests green
- [ ] **Step 2**: Smoke test: `mkdir /tmp/sk && node packages/cli/dist/cli.js install --target /tmp/sk --source packages/skills`
- [ ] **Step 3**: Verify manifest at `/tmp/sk/wiki-manifest.json`
- [ ] **Step 4**: Bump version to `0.3.0`, tag `v0.3.0-alpha`

---

## Phase 4: Templates

> **Note**: These are content authorship tasks. No TDD; instead "write content per spec section X, render-check, commit". Each template ≤ 200 lines.

### Task 4.1: `templates/SCHEMA.md`

**Source content:** Spec §"Vault Architecture" + §"Frontmatter Schemas" + §"Citation and Reference Conventions"

**Required sections:**
- Domain (placeholder line for users to fill)
- Conventions (filenames, dates, wikilinks, taxonomy reference)
- Frontmatter (4 schemas with examples)
- Citation rules (`^[raw/...]` markers, wikilinks, external URLs)
- Tag taxonomy (placeholder section: top-level categories)
- Page thresholds (Hermes rules: 2+ source mentions, 200-line split)
- Update policy (contradiction handling)

**Steps:**
- [ ] Write `templates/SCHEMA.md`
- [ ] Open in Obsidian or any markdown renderer to confirm formatting
- [ ] `git add templates/SCHEMA.md && git commit -m "feat(templates): SCHEMA.md vault template"`

---

### Task 4.2: `templates/index.md`

**Source content:** Hermes index format + §"Vault Architecture" projects/meta/ sections

**Required sections:**
- Header with last-updated date placeholder, total page count placeholder
- ## Entities, ## Concepts, ## Comparisons, ## Queries (Hermes-compat)
- ## Meta (cross-project synthesis — NEW)
- ## Projects (registered projects — NEW)

**Steps:**
- [ ] Write `templates/index.md`
- [ ] Commit: `feat(templates): index.md vault template`

---

### Task 4.3: `templates/log.md`

**Source content:** Hermes log format

**Format:**
```markdown
# Wiki Log
> Chronological record of all wiki actions. Append-only.
> Format: `## [YYYY-MM-DD] action | subject`
> Actions: ingest, update, query, lint, create, archive, delete, distill, decide
> When this file exceeds 500 entries, rotate.

## [{date}] create | Wiki initialized
- Domain: {domain}
- Structure created with SCHEMA.md, index.md, log.md, raw/, entities/, concepts/, comparisons/, queries/, meta/, projects/
```

**Steps:**
- [ ] Write `templates/log.md`
- [ ] Commit: `feat(templates): log.md vault template`

---

### Task 4.4: `templates/project-README.md`

**Source content:** Spec §"Vault Architecture" project structure + §"Cross-Skill Orientation Contract"

**Format:**
```markdown
---
title: {Project Name}
created: {date}
updated: {date}
status: planned | active | maintenance | archived
---

# {Project Name}

## Intent
{What this project is trying to achieve. The orientation contract reads this as project intent.}

## Structure
- `requirements/` — what we're building (incl. roadmap)
- `architecture/` — how it's designed (incl. ADRs)
- `work/` — dated work-item folders
- `compound/` — project-local concrete learnings

## Active Work
{Bullet list of in-progress work items, manually updated by proj-work skill.}

## Recent Lessons
{Bullet list linking to compound/ entries.}

## Related
- Cross-project meta: [[meta/{topic}]]
- Distilled to vault: [[concepts/{slug}]]
```

**Steps:**
- [ ] Write `templates/project-README.md`
- [ ] Commit: `feat(templates): project-README template`

---

## Phase 5: Knowledge-Layer Skills (`wiki-*`)

> **Note**: SKILL.md files are prompt-only Markdown describing skill behavior. They follow the structure: frontmatter (name, description, version, author, license), When This Skill Activates, Workflow, Pitfalls, Related Tools.

### Task 5.1: `wiki-init/SKILL.md`

**Source content:** Spec §"Skill Inventory — wiki-init" + §"Vault Architecture" + Hermes init flow

**Behavior described in skill:**
1. Determine vault path (from env `WIKI_PATH` or ask user; default `~/wiki`)
2. Create directory tree: `raw/{articles,papers,transcripts,assets}/`, `entities/`, `concepts/`, `comparisons/`, `queries/`, `meta/`, `projects/`
3. Ask user the domain
4. Copy `templates/SCHEMA.md` → `<vault>/SCHEMA.md`, customize Domain section
5. Copy `templates/index.md` → `<vault>/index.md`
6. Copy `templates/log.md` → `<vault>/log.md`, fill in `{date}` and `{domain}`
7. Confirm and suggest first ingestion

**Skill MUST:**
- Use `skillwiki validate` on a sample frontmatter to confirm setup
- Run `skillwiki hash` on the seed log entry to demonstrate the contract

**Steps:**
- [ ] Create `packages/skills/wiki-init/SKILL.md` (~150 lines)
- [ ] Manual smoke: invoke skill in scratch directory, verify tree
- [ ] Commit: `feat(skills): wiki-init`

---

### Task 5.2: `wiki-ingest/SKILL.md`

**Source content:** Spec §"Skill Inventory — wiki-ingest" + §"Workflow Patterns E2 prep" + §"Citation and Reference Conventions" + Hermes ingest flow

**Behavior described in skill:**
1. Orient (E5): read SCHEMA, index, recent log
2. Capture raw:
   - URL: run `skillwiki fetch-guard <url>`. If blocked, abort. Otherwise use Claude Code `WebFetch` and save to `raw/articles/<slug>.md`
   - File/paste: save to appropriate `raw/` subdir
   - Always compute `skillwiki hash <raw-file>` and store in raw frontmatter
3. Discuss takeaways with user (skip in batch mode)
4. Check existing pages (search index + filesystem)
5. Write/update wiki pages with **inline citations pre-attached** (Hermes `^[raw/...]` markers per Citation Conventions)
6. Atomic batch apply (F2): collect → apply pages → index → log
7. Re-ingest of same URL: hash unchanged → skip; hash changed → flag drift
8. Confidence: single-source pages get `confidence: low`; multi-source `medium`/`high`

**Skill MUST:**
- Always run `skillwiki fetch-guard` before any URL fetch
- Always run `skillwiki hash` on raw files
- Always run `skillwiki validate` on every page it writes (catch frontmatter errors before commit)

**Steps:**
- [ ] Create `packages/skills/wiki-ingest/SKILL.md` (~250 lines, comprehensive)
- [ ] Commit: `feat(skills): wiki-ingest`

---

### Task 5.3: `wiki-query/SKILL.md`

**Source content:** Spec §"Skill Inventory — wiki-query" + §"Workflow Patterns E2"

**Behavior described in skill:**
1. Orient (E5)
2. Determine scope from user: vault | current-project | project + concepts (default: vault)
3. Run `skillwiki graph build <vault>` and `skillwiki overlap <vault>` to get JSON precomputation
4. Identify candidate pages via index search + filesystem grep
5. Score candidates with the 4-signal weights (3.0× direct / 4.0× source-overlap / 1.5× Adamic-Adar / 1.0× type) using the JSON
6. Read top-N pages
7. Synthesize answer with `[[wikilink]]` citations
8. File substantial answers to `queries/` or `comparisons/`

**Steps:**
- [ ] Create `packages/skills/wiki-query/SKILL.md` (~200 lines)
- [ ] Commit: `feat(skills): wiki-query (E2 graph-aware)`

---

### Task 5.4: `wiki-lint/SKILL.md`

**Source content:** Spec §"Skill Inventory — wiki-lint" + §"Workflow Patterns E3" + Hermes lint flow

**Behavior described in skill:**
- Orient (E5)
- Run `skillwiki orphans <vault>`, `skillwiki validate <each page>`, `skillwiki hash <each raw>` to compare with stored sha256
- Hermes lint checks: orphans, broken links, index completeness, frontmatter, stale content, contradictions, page size, tag audit, log rotation
- E3 review queue: low-confidence + single-source, contested, orphan clusters, bridge nodes
- Severity ordering: broken links > orphans > drift > contested > stale > style
- Append `## [date] lint | N issues found` to log.md

**Steps:**
- [ ] Create `packages/skills/wiki-lint/SKILL.md` (~250 lines)
- [ ] Commit: `feat(skills): wiki-lint (E3 review queue)`

---

### Task 5.5: `wiki-crystallize/SKILL.md`

**Source content:** Spec §"Skill Inventory — wiki-crystallize"

**Behavior described in skill:**
- Distill working session into a typed-knowledge page
- **Auto-detect project context**: if cwd path includes `projects/{slug}/`, set `provenance: project` and `provenance_projects: ["[[slug]]"]`; else `provenance: research`
- Body comment: `<!-- crystallize_count: N -->` (increment on re-crystallize)
- Run `skillwiki validate` on the new page
- Update index.md and append to log.md

**Steps:**
- [ ] Create `packages/skills/wiki-crystallize/SKILL.md` (~150 lines)
- [ ] Commit: `feat(skills): wiki-crystallize`

---

### Task 5.6: `wiki-audit/SKILL.md`

**Source content:** Spec §"Skill Inventory — wiki-audit" + §"Citation and Reference Conventions"

**Behavior described in skill:**
- For each typed-knowledge page (or a single page argument), run `skillwiki audit <file>`
- Collate JSON results into a human-readable audit report
- Report categories:
  - Unresolved markers (`^[raw/missing.md]`)
  - Unreferenced sources (entry in `sources:` not cited in body)
  - Bare URLs in synthesis-heavy pages → "consider ingesting"
- Suggest fixes: "ingest URL X to make claim Y verifiable"

**Steps:**
- [ ] Create `packages/skills/wiki-audit/SKILL.md` (~150 lines)
- [ ] Commit: `feat(skills): wiki-audit`

---

## Phase 6: Project-Layer Skills (`proj-*`)

### Task 6.1: `proj-init/SKILL.md`

**Source content:** Spec §"Skill Inventory — proj-init" + §"Vault Architecture" project structure

**Behavior described in skill:**
- Ask user for project slug (lowercase, hyphens)
- Create `projects/{slug}/{requirements,architecture,work,compound}/`
- Copy `templates/project-README.md` → `projects/{slug}/README.md`, fill placeholders
- Register project in vault `index.md` under "## Projects" section
- Append to `log.md`: `## [date] create | project {slug} initialized`

**Steps:**
- [ ] Create `packages/skills/proj-init/SKILL.md` (~120 lines)
- [ ] Commit: `feat(skills): proj-init`

---

### Task 6.2: `proj-work/SKILL.md`

**Source content:** Spec §"Skill Inventory — proj-work" + §"Frontmatter Schemas — Schema 3"

**Behavior described in skill:**
- Override brainstorming/writing-plans default output paths to `projects/{slug}/work/YYYY-MM-DD-{slug}/`
- Create `spec.md` (from brainstorming output), `plan.md` (from writing-plans output), `log.md` (execution notes)
- Frontmatter: kind, status, priority, project, owner, started/completed dates
- Status lifecycle: planned → in-progress → completed (or abandoned)
- On status: completed → set `completed:` date, update project README "Active Work" section
- Run `skillwiki validate` on each work item file

**Steps:**
- [ ] Create `packages/skills/proj-work/SKILL.md` (~250 lines)
- [ ] Commit: `feat(skills): proj-work`

---

### Task 6.3: `proj-distill/SKILL.md`

**Source content:** Spec §"Skill Inventory — proj-distill" + §"Workflow Patterns E4"

**Behavior described in skill:**
- **2-step pattern (E4)**:
  - Step 1 (Analyze): read `projects/{slug}/compound/{file}.md` + linked work items. Output a candidate concept outline. Confirm with user.
  - Step 2 (Generate): write vault concept page with `provenance: project`, `provenance_projects: ["[[slug]]"]`, `work_items: [...]`. Set `promoted_to:` backlink on originating compound entry. Update index + log on both vault and project sides.
- Run `skillwiki validate` on the new concept page
- Run `skillwiki audit` to confirm citations resolve

**Steps:**
- [ ] Create `packages/skills/proj-distill/SKILL.md` (~200 lines)
- [ ] Commit: `feat(skills): proj-distill (E4 2-step pattern)`

---

### Task 6.4: `proj-decide/SKILL.md`

**Source content:** Spec §"Skill Inventory — proj-decide"

**Behavior described in skill:**
- Capture an architectural decision as ADR in `projects/{slug}/architecture/YYYY-MM-DD-{decision-slug}.md`
- ADR structure: Context, Decision, Consequences, Alternatives Considered
- If decision generalizes beyond the project, also create a `concepts/` page with `provenance: project` (or `mixed` if research-informed). Link both ways.
- Run `skillwiki validate` on both files

**Steps:**
- [ ] Create `packages/skills/proj-decide/SKILL.md` (~150 lines)
- [ ] Commit: `feat(skills): proj-decide`

---

## Phase 7: Integration, Docs, CI, Publish

### Task 7.1: End-to-end vault smoke test

**Files:**
- Create: `packages/cli/test/integration/vault-bootstrap.test.ts`

**Behavior:**
- In a tmpdir: copy `templates/` files into a fake "vault"
- Run `skillwiki validate` on a fixture page in `concepts/`
- Run `skillwiki graph build`, `skillwiki overlap`, `skillwiki orphans` against fixture
- Assert all return well-formed JSON with expected structure

**Steps:**
- [ ] Write integration test
- [ ] Run `npm test --workspace packages/cli`
- [ ] Commit: `test: end-to-end vault bootstrap`

---

### Task 7.2: Hermes wire-compat assertion test

**Files:**
- Create: `packages/cli/test/integration/hermes-compat.test.ts`

**Behavior:**
- Build a fixture vault using our templates + a few sample typed-knowledge pages with new `provenance:` fields and `aliases:`
- Parse the vault using only Hermes-known fields (title, created, updated, type, tags, sources, confidence, contested, contradictions)
- Assert: every page passes Hermes-shape validation (ignoring our additive fields)
- Assert: directory layout matches Hermes expectation (raw/, entities/, concepts/, comparisons/, queries/ all exist; meta/ and projects/ allowed but not required by Hermes)

**Steps:**
- [ ] Write test
- [ ] Run, verify pass
- [ ] Commit: `test: assert Hermes wire-compatibility (additive fields ignored)`

---

### Task 7.3: README.md (root + packages/cli)

**Files:**
- Create: `README.md` (root)
- Create: `packages/cli/README.md`

**Root README sections:**
- What this is (skillwiki + 10 Claude Code skills)
- Quick start (install command for Claude Code users)
- Architecture overview (link to spec)
- Repo layout (workspaces)
- Contributing
- License

**Package CLI README sections:**
- Installation (`npm install -g skillwiki` or `npx skillwiki`)
- Subcommand reference (table from spec §"Implementation Toolchain")
- JSON output examples for each subcommand
- Cross-platform notes
- License

**Steps:**
- [ ] Write both READMEs
- [ ] Commit: `docs: README files`

---

### Task 7.4: CLAUDE.md

**Files:**
- Create: `CLAUDE.md` (root)

**Sections:**
- Repo overview (1 paragraph)
- How skills relate to CLI (skills are prompt-only; CLI does deterministic data work)
- Spec location: `docs/superpowers/specs/2026-05-02-llm-wiki-skill-design.md`
- Plan location: `docs/superpowers/plans/2026-05-02-llm-wiki-skill.md` (this file)
- Build/test commands
- Hermes compat policy reminder

**Steps:**
- [ ] Write CLAUDE.md
- [ ] Commit: `docs: CLAUDE.md repo guide`

---

### Task 7.5: GitHub Actions CI

**Files:**
- Create: `.github/workflows/ci.yml`

**Workflow:**
- Triggers: push to main, PRs
- Matrix: Node 20, 22; OS ubuntu-latest, macos-latest, windows-latest
- Steps: checkout, setup-node, npm ci, npm run build, npm test
- Coverage upload (Codecov optional)

**Steps:**
- [ ] Write `.github/workflows/ci.yml`
- [ ] Push branch, verify workflow runs green on all matrix entries
- [ ] Commit: `ci: GitHub Actions cross-platform test matrix`

---

### Task 7.6: LICENSE

**Files:**
- Create: `LICENSE` (MIT)

**Steps:**
- [ ] Add standard MIT LICENSE text with copyright `2026 karlorz`
- [ ] Commit: `chore: MIT license`

---

### Task 7.7: npm publish (real, not dry-run)

**Steps:**
- [ ] **Step 1**: Final test sweep: `npm test --workspace packages/cli`
- [ ] **Step 2**: Bump version to `1.0.0`: edit `packages/cli/package.json` and `program.version()` in `cli.ts`
- [ ] **Step 3**: Build: `npm run build --workspace packages/cli`
- [ ] **Step 4**: Login to npm: `npm login`
- [ ] **Step 5**: Publish: `cd packages/cli && npm publish --access public`
- [ ] **Step 6**: Verify on npm registry: `npm view skillwiki`
- [ ] **Step 7**: Tag release: `git tag -a v1.0.0 -m "skillwiki v1.0.0 — Phase 7 complete"`
- [ ] **Step 8**: Push tags: `git push --tags`

---

## Self-Review Notes

**Spec coverage check:**
- Vault structure → Templates (Phase 4) + wiki-init (Task 5.1)
- 4 frontmatter schemas → Zod schemas (Task 1.5)
- 10 SKILL.md files → Phases 5 & 6
- skillwiki CLI 8 subcommands → Phases 1-3 (hash, fetch-guard, validate, graph build, overlap, orphans, audit, install)
- Cross-platform installer → Task 3.1
- Hermes wire-compat → Task 7.2 assertion test
- Citation conventions → wiki-audit (Task 5.6) + audit subcommand (Task 2.6)
- nashsu E1-E5 → E1 deferred to v1.1; E2 in wiki-query + graph/overlap; E3 in wiki-lint + orphans; E4 in proj-distill; E5 in all SKILL.md orientation sections

**Type consistency check:**
- `hashBodyBytes` used in `hash.ts` and `audit.ts` — same signature
- `parseFrontmatter` used in `validate.ts` — single source of truth
- Schema names match spec section names exactly: `TypedKnowledgeSchema`, `RawSchema`, `WorkItemSchema`, `CompoundSchema`

**Phases 2-7 granularity caveat:** Per the note in the header, Phases 2-7 use task-outline + behavior-spec format rather than full step-by-step TDD. The CLI subcommand tasks (Phase 2) have enough sketched implementation to follow Phase 1's pattern. SKILL.md tasks (Phases 5-6) reference spec sections rather than reproducing content. If executing Phases 2-7 reveals ambiguity, **stop and re-plan that phase as a follow-up plan file** (`docs/superpowers/plans/2026-05-DD-phase-N-detail.md`).

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-05-02-llm-wiki-skill.md`.**

Two execution options:

1. **Subagent-Driven (recommended)** — Dispatch a fresh subagent per task, review between tasks, fast iteration. REQUIRED SUB-SKILL: `superpowers:subagent-driven-development`.

2. **Inline Execution** — Execute tasks in this session using `superpowers:executing-plans`, batch with checkpoints.

**Which approach?**
