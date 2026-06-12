export interface OkResult<T> {
  ok: true;
  data: T;
}

export interface ErrResult {
  ok: false;
  error: string;
  detail?: unknown;
}

export type Result<T> = OkResult<T> | ErrResult;

export function ok<T>(data: T): OkResult<T> {
  return { ok: true, data };
}

export function err(error: string, detail?: unknown): ErrResult {
  return detail === undefined ? { ok: false, error } : { ok: false, error, detail };
}

export interface CommandRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type CommandRunner = (
  command: string,
  args: string[],
  options: { cwd: string }
) => Promise<CommandRunResult>;

export type MaintenanceJobId =
  | "self-update-check"
  | "vault-sync-preflight"
  | "agent-memory-trends-daily"
  | "session-brief-refresh"
  | "health-summary";

export type JobStatus = "pass" | "warn" | "fail" | "skip";

export interface JobCheck<TDetails = unknown> {
  job: MaintenanceJobId;
  status: JobStatus;
  reason: string;
  details: TDetails;
}
