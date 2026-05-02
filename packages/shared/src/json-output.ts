export interface OkResult<T> { ok: true; data: T }
export interface ErrResult { ok: false; error: string; detail?: unknown }
export type Result<T> = OkResult<T> | ErrResult;

export function ok<T>(data: T): OkResult<T> { return { ok: true, data }; }
export function err(error: string, detail?: unknown): ErrResult {
  return detail === undefined ? { ok: false, error } : { ok: false, error, detail };
}
export function isOk<T>(r: Result<T>): r is OkResult<T> { return r.ok === true; }
export function isErr<T>(r: Result<T>): r is ErrResult { return r.ok === false; }
