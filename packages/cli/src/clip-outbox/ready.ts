export interface ReadyFile {
  path: string;
  sha256: string;
}

export interface ReadyHint {
  vault_id: string;
  files: ReadyFile[];
}

export function buildReadyHint(vaultId: string, files: ReadyFile[]): ReadyHint {
  const assets = files.filter((f) => f.path.startsWith("raw/assets/"));
  const articles = files.filter((f) => f.path.startsWith("raw/articles/"));
  return { vault_id: vaultId, files: [...assets, ...articles] };
}

export async function postReadyHint(opts: {
  url: string;
  token: string;
  hint: ReadyHint;
  fetchImpl?: typeof fetch;
}): Promise<{ ok: true } | { ok: false; status: number }> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const body = JSON.stringify(opts.hint);
  if (Buffer.byteLength(body) > 32768) return { ok: false, status: 413 };
  const res = await fetchImpl(opts.url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${opts.token}`,
      "Content-Type": "application/json",
    },
    body,
    signal: AbortSignal.timeout(10_000),
    redirect: "error",
  });
  if (!res.ok) return { ok: false, status: res.status };
  const result = await res.json() as { ok?: boolean; paths?: unknown };
  const paths = result.paths;
  // A queued/202 acknowledgment alone is not central visibility.
  return result.ok === true && Array.isArray(paths) && opts.hint.files.every((f) => paths.includes(f.path))
    ? { ok: true } : { ok: false, status: 503 };
}
