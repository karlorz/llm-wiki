import { createHash } from "node:crypto";

export type SensitiveKind =
  | "access_key"
  | "api_key"
  | "authorization_header"
  | "cookie"
  | "jwt"
  | "password"
  | "private_key"
  | "provider_key"
  | "secret"
  | "token";

export interface SensitiveFinding {
  file?: string;
  line: number;
  kind: SensitiveKind;
  preview: string;
  fingerprint: string;
}

export interface SensitiveScanOptions {
  file?: string;
}

export interface SensitiveRedactionResult {
  text: string;
  changed: boolean;
  findings: SensitiveFinding[];
}

interface Match {
  start: number;
  end: number;
  valueStart: number;
  valueEnd: number;
  kind: SensitiveKind;
}

interface Matcher {
  kind: SensitiveKind;
  re: RegExp;
  valueGroup?: number;
}

const REDACTED_RE = /\[REDACTED:[^\]]+\]/i;
const SYNTHETIC_RE = /^(?:<[^>]+>|\$\{[^}]+\}|REPLACE_WITH_[A-Z0-9_]+|YOUR_[A-Z0-9_]+|EXAMPLE_[A-Z0-9_]+)$/i;

const MATCHERS: Matcher[] = [
  {
    kind: "private_key",
    re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
  },
  {
    kind: "authorization_header",
    re: /\bAuthorization["']?\s*:\s*["']?(Bearer\s+[A-Za-z0-9._~+/-]{20,})["']?/gi,
    valueGroup: 1,
  },
  {
    kind: "cookie",
    re: /\b(?:Cookie|Set-Cookie)\s*:\s*([^\n]{20,})/gi,
    valueGroup: 1,
  },
  {
    kind: "jwt",
    re: /\b([A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,})\b/g,
    valueGroup: 1,
  },
  {
    kind: "provider_key",
    re: /\b(sk-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|gh[pousr]_[A-Za-z0-9_=-]{20,})\b/g,
    valueGroup: 1,
  },
  {
    kind: "access_key",
    re: /\b((?:AKIA|ASIA)[A-Z0-9]{16})\b/g,
    valueGroup: 1,
  },
  {
    kind: "access_key",
    re: /\b(?:access[-_ ]?key|credential)["']?\s*[:=]\s*["']?([A-Za-z0-9._~+/-]{20,})["']?/gi,
    valueGroup: 1,
  },
  {
    kind: "api_key",
    re: /\b(?:api[-_ ]?key)["']?\s*[:=]\s*["']?([A-Za-z0-9._~+/-]{20,})["']?/gi,
    valueGroup: 1,
  },
  {
    kind: "password",
    re: /\b(?:pass(?:word|wd)?)["']?\s*[:=]\s*["']?([^\s`"']{8,})["']?/gi,
    valueGroup: 1,
  },
  {
    kind: "secret",
    re: /\b(?:secret|client[-_ ]?secret)["']?\s*[:=]\s*["']?([A-Za-z0-9._~+/-]{16,})["']?/gi,
    valueGroup: 1,
  },
  {
    kind: "token",
    re: /\b(?:token|session)["']?\s*[:=]\s*["']?([A-Za-z0-9._~+/-]{16,})["']?/gi,
    valueGroup: 1,
  },
];

function fingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function lineFor(text: string, offset: number): number {
  return text.slice(0, offset).split(/\r?\n/).length;
}

function redactMarker(kind: SensitiveKind, value: string): string {
  return `[REDACTED:${kind}:${fingerprint(value)}]`;
}

function isSyntheticPlaceholder(value: string): boolean {
  return REDACTED_RE.test(value) || SYNTHETIC_RE.test(value.trim());
}

function collectMatches(text: string): Match[] {
  const matches: Match[] = [];
  for (const matcher of MATCHERS) {
    matcher.re.lastIndex = 0;
    for (const m of text.matchAll(matcher.re)) {
      const whole = m[0]!;
      const start = m.index ?? 0;
      if (REDACTED_RE.test(whole)) continue;

      const value = matcher.valueGroup ? m[matcher.valueGroup] : whole;
      if (isSyntheticPlaceholder(value)) continue;

      const valueOffset = whole.lastIndexOf(value);
      const valueStart = start + Math.max(0, valueOffset);
      matches.push({
        start,
        end: start + whole.length,
        valueStart,
        valueEnd: valueStart + value.length,
        kind: matcher.kind,
      });
    }
  }
  return matches.sort((a, b) => {
    if (a.valueStart !== b.valueStart) return a.valueStart - b.valueStart;
    return (b.valueEnd - b.valueStart) - (a.valueEnd - a.valueStart);
  });
}

function collapseOverlaps(matches: Match[]): Match[] {
  const kept: Match[] = [];
  for (const match of matches) {
    const overlaps = kept.some(k => match.valueStart < k.valueEnd && match.valueEnd > k.valueStart);
    if (!overlaps) kept.push(match);
  }
  return kept;
}

export function scanSensitiveContent(text: string, opts: SensitiveScanOptions = {}): SensitiveFinding[] {
  return collapseOverlaps(collectMatches(text)).map(match => {
    const value = text.slice(match.valueStart, match.valueEnd);
    const marker = redactMarker(match.kind, value);
    const rawPreview = text.slice(Math.max(0, match.start - 24), Math.min(text.length, match.end + 24));
    const preview = rawPreview.replace(value, marker);
    return {
      file: opts.file,
      line: lineFor(text, match.valueStart),
      kind: match.kind,
      preview,
      fingerprint: fingerprint(value),
    };
  });
}

export function redactSensitiveContent(text: string, opts: SensitiveScanOptions = {}): SensitiveRedactionResult {
  const matches = collapseOverlaps(collectMatches(text));
  if (matches.length === 0) return { text, changed: false, findings: [] };

  let out = "";
  let cursor = 0;
  for (const match of matches) {
    const value = text.slice(match.valueStart, match.valueEnd);
    out += text.slice(cursor, match.valueStart);
    out += redactMarker(match.kind, value);
    cursor = match.valueEnd;
  }
  out += text.slice(cursor);

  return {
    text: out,
    changed: out !== text,
    findings: scanSensitiveContent(text, opts),
  };
}
