import { readFileSync, writeFileSync } from "node:fs";
import { err, ok, ExitCode, type Result } from "@skillwiki/shared";
import {
  HOST_ID_RE,
  appendHostHash,
  generateHostBearer,
  parseMcpTokenMap,
} from "../utils/mcp-token-map.js";

export interface McpAuthIssueHostInput {
  hostId: string;
  mapPath: string;
  write?: boolean;
  isTty?: boolean;
  rng?: () => Buffer;
  readFile?: typeof readFileSync;
  writeFile?: typeof writeFileSync;
  stderrWrite?: (s: string) => void;
}

export type McpAuthIssueHostData = {
  host_id: string;
  hash_prefix: string;
  map_path: string;
  wrote: boolean;
};

function isEnoent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function preflight(error: string): { exitCode: number; result: Result<McpAuthIssueHostData> } {
  return { exitCode: ExitCode.PREFLIGHT_FAILED, result: err(error) };
}

export async function runMcpAuthIssueHost(
  input: McpAuthIssueHostInput,
): Promise<{ exitCode: number; result: Result<McpAuthIssueHostData> }> {
  const isTty = input.isTty ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const readFile = input.readFile ?? readFileSync;
  const writeFile = input.writeFile ?? writeFileSync;
  const stderrWrite = input.stderrWrite ?? ((s: string) => {
    process.stderr.write(s);
  });
  const write = Boolean(input.write);
  const mapPath = input.mapPath;
  const hostId = input.hostId;

  if (!mapPath) return preflight("MAP_PATH_REQUIRED");
  if (!HOST_ID_RE.test(hostId)) return preflight("INVALID_HOST_ID");
  if (write && !isTty) return preflight("NO_TTY");

  let yamlText = "";
  try {
    yamlText = readFile(mapPath, "utf8") as string;
  } catch (error) {
    if (!isEnoent(error)) throw error;
  }

  const map = parseMcpTokenMap(yamlText);
  if ([...map.values()].includes(hostId)) return preflight("DUPLICATE_HOST_ID");

  if (!write) {
    return {
      exitCode: ExitCode.OK,
      result: ok({
        host_id: hostId,
        hash_prefix: "",
        map_path: mapPath,
        wrote: false,
      }),
    };
  }

  const { raw, hashHex } = generateHostBearer(input.rng);
  const appended = appendHostHash(yamlText, hashHex, hostId);
  if ("error" in appended) return preflight(appended.error);

  try {
    writeFile(mapPath, appended.yaml, { encoding: "utf8", mode: 0o640 });
  } catch (error) {
    if (isEnoent(error)) {
      return { exitCode: ExitCode.FILE_NOT_FOUND, result: err("FILE_NOT_FOUND") };
    }
    throw error;
  }

  stderrWrite(`issued host_id=${hostId} copy once: ${raw}\n`);
  return {
    exitCode: ExitCode.OK,
    result: ok({
      host_id: hostId,
      hash_prefix: hashHex.slice(0, 8),
      map_path: mapPath,
      wrote: true,
    }),
  };
}
