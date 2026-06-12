import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { err, ok, type CommandRunner, type JobCheck } from "../types.js";
import { runWriteTransaction, type WriteTransactionDetails } from "../write-transaction.js";

export interface SessionBriefRefreshInput {
  vaultPath: string;
  repoPath: string;
  project: string;
  runCommand: CommandRunner;
}

export interface SessionBriefRefreshData {
  filesWritten: string[];
}

const SESSION_BRIEF_ALLOWLIST = [
  ".skillwiki/session-brief.json",
  ".skillwiki/session-brief.md",
  "index.md",
  "log.md",
  "meta/latest-session-brief.md",
];

interface LastOpSnapshot {
  path: string;
  existed: boolean;
  body: string;
}

export async function runSessionBriefRefresh(
  input: SessionBriefRefreshInput
): Promise<JobCheck<WriteTransactionDetails<SessionBriefRefreshData>>> {
  return runWriteTransaction({
    job: "session-brief-refresh",
    repoPath: input.vaultPath,
    allowlist: SESSION_BRIEF_ALLOWLIST,
    commitMessage: "chore(maintenance): refresh session brief",
    runCommand: input.runCommand,
    run: async () => {
      const home = createAutoCommitDisabledHome(input.vaultPath);
      const lastOp = snapshotLastOp(input.vaultPath);
      let restoreError: unknown;
      const result = await input.runCommand(
        "skillwiki",
        ["session-brief", input.vaultPath, "--project", input.project, "--write"],
        {
          cwd: input.repoPath,
          env: {
            HOME: home,
            SKILLWIKI_PROJECT: input.project,
          },
        }
      ).finally(() => {
        try {
          restoreLastOp(lastOp);
          rmSync(home, { recursive: true, force: true });
        } catch (error) {
          restoreError = error;
        }
      });

      if (restoreError) {
        return err("SESSION_BRIEF_LAST_OP_RESTORE_FAILED", restoreError instanceof Error ? restoreError.message : String(restoreError));
      }
      if (result.exitCode !== 0) {
        return err("SESSION_BRIEF_FAILED", {
          stderr: result.stderr,
          stdout: result.stdout,
        });
      }
      return ok({ filesWritten: SESSION_BRIEF_ALLOWLIST });
    },
  });
}

function createAutoCommitDisabledHome(vaultPath: string): string {
  const home = mkdtempSync(join(tmpdir(), "skillwiki-maintenance-home-"));
  const configDir = join(home, ".skillwiki");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, ".env"), `WIKI_PATH=${vaultPath}\nAUTO_COMMIT=false\n`, "utf8");
  return home;
}

function snapshotLastOp(vaultPath: string): LastOpSnapshot {
  const path = join(vaultPath, ".skillwiki", "last-op.json");
  if (!existsSync(path)) return { path, existed: false, body: "" };
  return { path, existed: true, body: readFileSync(path, "utf8") };
}

function restoreLastOp(snapshot: LastOpSnapshot): void {
  if (snapshot.existed) {
    writeFileSync(snapshot.path, snapshot.body, "utf8");
    return;
  }
  try {
    unlinkSync(snapshot.path);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
}
