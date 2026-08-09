type UnknownRecord = Record<string, unknown>;

export function lintDetailHints(data: unknown): string[] {
  const record = asRecord(data);
  if (!record) return [];
  const bySeverity = asRecord(record.by_severity);
  if (bySeverity && Array.isArray(bySeverity.error)) {
    return detailLines(bySeverity.error, false);
  }
  return Array.isArray(record.buckets) ? detailLines(record.buckets, true) : [];
}

export function healthLintDetailHints(data: unknown): string[] {
  const record = asRecord(data);
  const components = asRecord(record?.components);
  const lint = asRecord(components?.lint);
  return Array.isArray(lint?.buckets) ? detailLines(lint.buckets, true) : [];
}

function detailLines(buckets: unknown[], requireErrorSeverity: boolean): string[] {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const bucket of buckets) {
    const record = asRecord(bucket);
    if (!record || (requireErrorSeverity && record.severity !== "error")) continue;
    const name = nonEmptyBucketName(record);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    lines.push(`detail: skillwiki lint --only ${name} --examples 3`);
  }
  return lines;
}

function nonEmptyBucketName(bucket: UnknownRecord): string | null {
  if (typeof bucket.kind !== "string" || !/^[a-z0-9_]+$/.test(bucket.kind)) return null;
  if (typeof bucket.count === "number") return bucket.count > 0 ? bucket.kind : null;
  if (Array.isArray(bucket.items)) return bucket.items.length > 0 ? bucket.kind : null;
  return null;
}

function asRecord(value: unknown): UnknownRecord | null {
  return typeof value === "object" && value !== null ? value as UnknownRecord : null;
}
