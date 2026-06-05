export type SourceIdentityStatus = "ok" | "suspicious" | "conflict";

export interface SourceIdentityInput {
  rawPath: string;
  sourceUrl?: string;
  body?: string;
}

export interface SourceIdentityAssessment {
  status: SourceIdentityStatus;
  pathSignals: string[];
  sourceSignals: string[];
  bodySignals: string[];
  reasons: string[];
}

const PROJECT_PATTERNS: Record<string, RegExp[]> = {
  hermes: [/\bhermes\b/i, /nousresearch\s*hermes/i, /nousresearch\/hermes-agent/i, /hermes agent/i],
  skillwiki: [/\bskillwiki\b/i, /\bllm[-_ ]?wiki\b/i, /karpathy'?s llm wiki/i],
  superpowers: [/\bsuperpowers\b/i, /obra\/superpowers/i, /complete software development methodology/i],
  playwright: [/\bplaywright\b/i, /microsoft\s*playwright/i, /microsoft\/playwright/i],
  convex: [/\bconvex\b/i],
  newapi: [/\bnew[-_ ]?api\b/i, /quantumnous\/new-api/i],
  coolify: [/\bcoolify\b/i, /coollabsio\/coolify/i],
  seaweedfs: [/\bseaweed\s*fs\b/i],
  proxmox: [/\bproxmox\b/i, /proxmoxve/i],
  codestable: [/\bcodestable\b/i],
};

const COMPATIBLE = new Set([
  "hermes|skillwiki",
  "skillwiki|hermes",
  "proxmox|seaweedfs",
  "seaweedfs|proxmox",
  "coolify|seaweedfs",
  "seaweedfs|coolify",
]);

function normalize(text: string): string {
  return text
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .replace(/[_-]+/g, " ");
}

function firstBodyWindow(body: string | undefined): string {
  if (!body) return "";
  const withoutFrontmatter = body.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
  return withoutFrontmatter.slice(0, 2000);
}

function collectSignals(text: string): string[] {
  const normalized = normalize(text);
  const found: string[] = [];
  for (const [name, patterns] of Object.entries(PROJECT_PATTERNS)) {
    if (patterns.some(pattern => pattern.test(normalized))) found.push(name);
  }
  return found;
}

function compatible(left: string, right: string): boolean {
  return left === right || COMPATIBLE.has(`${left}|${right}`);
}

function hasAnyIncompatibleSignals(leftSignals: string[], rightSignals: string[]): boolean {
  if (leftSignals.length === 0 || rightSignals.length === 0) return false;
  return leftSignals.some(left => rightSignals.some(right => !compatible(left, right)));
}

function hasAnyCompatibleSignals(leftSignals: string[], rightSignals: string[]): boolean {
  return leftSignals.some(left => rightSignals.some(right => compatible(left, right)));
}

export function assessSourceIdentity(input: SourceIdentityInput): SourceIdentityAssessment {
  const pathSignals = collectSignals(input.rawPath);
  const sourceSignals = collectSignals(input.sourceUrl ?? "");
  const bodySignals = collectSignals(firstBodyWindow(input.body));
  const reasons: string[] = [];

  if (hasAnyIncompatibleSignals(pathSignals, sourceSignals)) {
    reasons.push(`filename/path signals [${pathSignals.join(", ")}] but source_url signals [${sourceSignals.join(", ")}]`);
  }

  if (
    pathSignals.length > 0
    && bodySignals.length > 0
    && !hasAnyCompatibleSignals(pathSignals, bodySignals)
  ) {
    reasons.push(`filename/path signals [${pathSignals.join(", ")}] but body signals [${bodySignals.join(", ")}]`);
  }

  if (reasons.length > 0) {
    return { status: "conflict", pathSignals, sourceSignals, bodySignals, reasons };
  }

  if (
    pathSignals.length === 0
    && sourceSignals.length > 0
    && bodySignals.length > 0
    && !hasAnyCompatibleSignals(sourceSignals, bodySignals)
  ) {
    return {
      status: "suspicious",
      pathSignals,
      sourceSignals,
      bodySignals,
      reasons: [`source_url signals [${sourceSignals.join(", ")}] but body signals [${bodySignals.join(", ")}]`],
    };
  }

  return { status: "ok", pathSignals, sourceSignals, bodySignals, reasons };
}
