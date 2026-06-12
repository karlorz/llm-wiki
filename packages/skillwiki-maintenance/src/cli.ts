import { homedir } from "node:os";
import { join } from "node:path";
import { defaultFleetPath, runStage1Maintenance } from "./orchestrator.js";

interface CliOptions {
  command: string;
  fleetPath: string;
  hostId: string;
  lockDir: string;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2), process.env);
  if (options.command !== "run") {
    console.error("Usage: skillwiki-maintenance run [--fleet <path>] [--host <id>] [--lock-dir <path>]");
    process.exitCode = 46;
    return;
  }

  const result = await runStage1Maintenance({
    fleetPath: options.fleetPath,
    hostId: options.hostId,
    lockDir: options.lockDir,
    now: new Date(),
    emit: (event) => console.log(JSON.stringify(event)),
  });

  if (!result.ok) {
    console.log(JSON.stringify({ ts: new Date().toISOString(), event: "error", host_id: options.hostId, error: result.error, detail: result.detail }));
    process.exitCode = 1;
    return;
  }
}

function parseArgs(args: string[], env: NodeJS.ProcessEnv): CliOptions {
  const command = args[0] ?? "";
  const vault = env.AGENT_MEMORY_TRENDS_VAULT ?? env.WIKI_PATH ?? "/home/agent-memory/wiki";
  const options: CliOptions = {
    command,
    fleetPath: env.SKILLWIKI_MAINTENANCE_FLEET ?? defaultFleetPath(vault),
    hostId: env.SKILLWIKI_MAINTENANCE_HOST_ID ?? env.SKILLWIKI_HOST_ID ?? "sg02",
    lockDir: env.SKILLWIKI_MAINTENANCE_LOCK_DIR ?? join(homedir(), ".local", "state", "skillwiki-maintenance", "lock"),
  };

  for (let i = 1; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--fleet") options.fleetPath = args[++i] ?? options.fleetPath;
    else if (arg === "--host") options.hostId = args[++i] ?? options.hostId;
    else if (arg === "--lock-dir") options.lockDir = args[++i] ?? options.lockDir;
  }

  return options;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
