# config and doctor commands — Design Spec

**Goal:** Add `skillwiki config` (get/set/list/path) and `skillwiki doctor` (pre-flight diagnostic) to the CLI, eliminating the need to manually edit `~/.skillwiki/.env` and providing a single command to verify the full setup.

**Architecture:** Two new subcommands backed by the existing `~/.skillwiki/.env` store and `dotenv.ts` parser. Doctor runs local filesystem checks only (no network). Both follow the existing `Result<T>` envelope pattern and exit-code conventions.

---

## 1. `skillwiki config`

### Subcommands

| Subcommand | Signature | Description |
|---|---|---|
| `get` | `config get <key>` | Print value of a single config key. Exit 1 if not set. |
| `set` | `config set <key> <value>` | Write or update a key. Creates `~/.skillwiki/` and `.env` if missing. |
| `list` | `config list` | Print all key=value pairs. Empty output if no config exists. |
| `path` | `config path` | Print the `.env` file path (`~/.skillwiki/.env`). |

### Valid keys

Only `WIKI_PATH` and `WIKI_LANG` are accepted. Any other key exits with code 26 (`INVALID_CONFIG_KEY`).

### Backing store

Reads and writes `~/.skillwiki/.env` directly. Reuses the existing `dotenv.ts` parser for reads. A new `writeDotenv(filePath, data)` function serializes the full key-value map back to the file, preserving comments and blank lines from the original content.

If the file does not exist, `set` creates both `~/.skillwiki/` (mkdir) and the `.env` file. If the file exists, `set` updates only the target key line, leaving other lines intact.

### Output

All subcommands return a `Result<T>` JSON envelope:

- `get`: `{ ok: true, data: { key: "WIKI_PATH", value: "/path/to/vault" } }`
- `set`: `{ ok: true, data: { key: "WIKI_PATH", value: "/new/path", written: true } }`
- `list`: `{ ok: true, data: { entries: [{ key: "WIKI_PATH", value: "..." }, ...] } }`
- `path`: `{ ok: true, data: { path: "/home/user/.skillwiki/.env", exists: true } }`

### Exit codes

| Code | Constant | Condition |
|---|---|---|
| 0 | `OK` | Success |
| 26 | `INVALID_CONFIG_KEY` | Key not in whitelist |
| 27 | `CONFIG_WRITE_FAILED` | Filesystem write error |

### `--human` rendering

- `get`: prints just the value
- `set`: prints `KEY=VALUE` and confirmation
- `list`: prints one `KEY=VALUE` per line
- `path`: prints the file path

---

## 2. `skillwiki doctor`

Runs a fixed set of local checks and reports pass/warn/error per check.

### Checks

| # | ID | Label | Pass condition | Fail severity |
|---|---|---|---|---|
| 1 | `node_version` | Node.js version | `process.version` major >= 20 | error |
| 2 | `cli_on_path` | skillwiki on PATH | `which skillwiki` resolves; skip when run via `node cli.js` (detect by checking if `process.argv[1]` ends with `cli.js`) | warn |
| 3 | `config_file` | Config file exists | `~/.skillwiki/.env` exists and is parseable | warn |
| 4 | `wiki_path_set` | WIKI_PATH configured | `WIKI_PATH` resolves to a non-empty value through the full chain (flag > env > dotenv) | error |
| 5 | `wiki_path_exists` | Vault directory exists | The resolved WIKI_PATH points to an existing directory | error |
| 6 | `vault_structure` | Vault structure valid | Vault has `SCHEMA.md` and subdirs: `raw`, `entities`, `concepts`, `meta` | error |
| 7 | `skills_installed` | Skills installed | `~/.claude/skills/` contains at least one `SKILL.md` file (recursive glob) | warn |

### Execution

All checks run synchronously. No network calls. Total runtime < 1 second.

Doctor does **not** take a `[vault]` argument — it uses the standard runtime resolution chain (same as `lint`, `links`, etc.) to find the vault.

### Output

```json
{
  "ok": true,
  "data": {
    "checks": [
      { "id": "node_version", "label": "Node.js version", "status": "pass", "detail": "v22.1.0" },
      { "id": "cli_on_path", "label": "skillwiki on PATH", "status": "pass", "detail": "/usr/local/bin/skillwiki" },
      { "id": "config_file", "label": "Config file exists", "status": "warn", "detail": "~/.skillwiki/.env not found" },
      { "id": "wiki_path_set", "label": "WIKI_PATH configured", "status": "pass", "detail": "env WIKI_PATH=/home/user/wiki" },
      { "id": "wiki_path_exists", "label": "Vault directory exists", "status": "pass", "detail": "/home/user/wiki" },
      { "id": "vault_structure", "label": "Vault structure valid", "status": "pass", "detail": "SCHEMA.md present, 4/4 subdirs present" },
      { "id": "skills_installed", "label": "Skills installed", "status": "pass", "detail": "10 SKILL.md files found" }
    ],
    "summary": { "pass": 6, "warn": 1, "error": 0 }
  }
}
```

### Exit codes

| Code | Constant | Condition |
|---|---|---|
| 0 | `OK` | All checks pass (warnings allowed) |
| 28 | `DOCTOR_HAS_WARNINGS` | Only warnings, no errors |
| 29 | `DOCTOR_HAS_ERRORS` | At least one error |

### `--human` rendering

Prints a table:

```
  ✓ Node.js version          v22.1.0
  ✓ skillwiki on PATH        /usr/local/bin/skillwiki
  ⚠ Config file exists       ~/.skillwiki/.env not found
  ✓ WIKI_PATH configured     env WIKI_PATH=/home/user/wiki
  ✓ Vault directory exists   /home/user/wiki
  ✓ Vault structure valid    SCHEMA.md present, 4/4 subdirs
  ✓ Skills installed         10 SKILL.md files

6 pass · 1 warn · 0 error
```

---

## 3. Exit codes added to shared

File: `packages/shared/src/exit-codes.ts`

```typescript
INVALID_CONFIG_KEY: 26,
CONFIG_WRITE_FAILED: 27,
DOCTOR_HAS_WARNINGS: 28,
DOCTOR_HAS_ERRORS: 29,
```

Codes 26–29 are currently unused and follow the existing stable-code policy (N6).

---

## 4. File changes summary

| File | Action |
|---|---|
| `packages/shared/src/exit-codes.ts` | Add 4 new exit codes |
| `packages/cli/src/utils/dotenv.ts` | Add `writeDotenv(filePath, entries, originalContent?)` |
| `packages/cli/src/commands/config.ts` | New: implements `config get/set/list/path` |
| `packages/cli/src/commands/doctor.ts` | New: implements 7 diagnostic checks |
| `packages/cli/src/cli.ts` | Register `config` and `doctor` commands |
| `packages/cli/test/commands/config.test.ts` | New: unit tests for config subcommands |
| `packages/cli/test/commands/doctor.test.ts` | New: unit tests for doctor checks |

---

## 5. CLI registration (cli.ts)

```typescript
// config — grouped under a parent command
const configCmd = program.command("config").description("manage skillwiki configuration");

configCmd
  .command("get <key>")
  .action(async (key) => emit(await runConfigGet({ key, home: process.env.HOME ?? "" })));

configCmd
  .command("set <key> <value>")
  .action(async (key, value) => emit(await runConfigSet({ key, value, home: process.env.HOME ?? "" })));

configCmd
  .command("list")
  .action(async () => emit(await runConfigList({ home: process.env.HOME ?? "" })));

configCmd
  .command("path")
  .action(async () => emit(await runConfigPath({ home: process.env.HOME ?? "" })));

// doctor
program
  .command("doctor")
  .description("diagnose skillwiki setup issues")
  .action(async () => emit(await runDoctor({
    home: process.env.HOME ?? "",
    envValue: process.env.WIKI_PATH,
    envLang: process.env.WIKI_LANG,
    argv: process.argv
  })));
```

---

## 6. Out of scope

- Interactive setup wizard (the `wiki-init` skill handles guided setup)
- Config migration from other formats
- Network-based checks (registry connectivity, skill updates)
- `config unset` / `config delete` (can be added later if needed)
- Per-vault config (vault-level `.env` override)
