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
  const res = await fetchImpl(opts.url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${opts.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(opts.hint),
  });
  return res.ok ? { ok: true } : { ok: false, status: res.status };
}
