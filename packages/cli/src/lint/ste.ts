const URL_RE = /https?:\/\/[^\s)<>]+/gi;
const CITATION_RE = /\^\[raw\/[^\]]+\]/g;
const FENCE_OPEN = /^(\s*)(`{3,}|~{3,})(.*)$/;
const HEADING_RE = /^(#{1,6})\s+(\S.*)$/;
const ORDERED_ITEM_RE = /^(\s*)\d+\.\s+(.*)$/;
const UNORDERED_ITEM_RE = /^(\s*)[-*+]\s+(.*)$/;
const TABLE_ROW_RE = /^\s*\|.*\|\s*$/;
const BLOCKQUOTE_RE = /^\s*>/;
const LEAST_CERTAIN_RE = /^\s*\*\*Least certain:\*\*\s*$/;
const UNCERTAINTY_HEADING_RE = /^##\s+Uncertainty\s*$/i;
const STEPS_HEADING_RE = /^(Steps|Procedure)\b/i;
const LEAST_CERTAIN_FOLLOWING_RE = /^\s*\*\*Least certain:\*\*\s*\n(?:[ \t]*[-*+][ \t]+\S.*\n?)+/;
const HEDGE_PHRASES = ["appears to", "could be"] as const;
const HEDGE_WORDS = [
  "might",
  "may",
  "perhaps",
  "possibly",
  "probably",
  "likely",
  "seems",
  "arguably",
  "somewhat",
] as const;

export const STE_PROSE_WORD_LIMIT = 25;
export const STE_INSTRUCTION_WORD_LIMIT = 20;

export function isOutputStandardV2(fm: Record<string, unknown>): boolean {
  return fm.output_standard === "v2";
}

export function stripUrlsAndCitations(text: string): string {
  return text.replace(URL_RE, " ").replace(CITATION_RE, " ");
}

export function countWords(text: string): number {
  const cleaned = stripUrlsAndCitations(text).trim();
  if (!cleaned) return 0;
  return cleaned.split(/\s+/).filter(Boolean).length;
}

export function splitSentences(text: string): string[] {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return [];
  return normalized.split(/(?<=[.!?])\s+/).map((part) => part.trim()).filter(Boolean);
}

function hedgePattern(): RegExp {
  const phrases = HEDGE_PHRASES.map((p) => p.replace(/\s+/g, "\\s+"));
  const words = HEDGE_WORDS.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`\\b(?:${[...phrases, ...words].join("|")})\\b`, "gi");
}

export function findHedgeMatches(text: string): string[] {
  const matches = text.match(hedgePattern());
  if (!matches) return [];
  return [...new Set(matches.map((m) => m.toLowerCase().replace(/\s+/g, " ")))];
}

interface FenceState {
  open: boolean;
  marker: string;
}

function toggleFence(line: string, fence: FenceState): boolean {
  const match = line.match(FENCE_OPEN);
  if (!match) return false;
  const marker = match[2]!;
  if (!fence.open) {
    fence.open = true;
    fence.marker = marker;
    return true;
  }
  if (marker[0] === fence.marker[0] && marker.length >= fence.marker.length && match[3]!.trim() === "") {
    fence.open = false;
    fence.marker = "";
    return true;
  }
  return false;
}

function isTableSeparator(line: string): boolean {
  return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
}

export function hasMarkdownTable(body: string): boolean {
  const fence: FenceState = { open: false, marker: "" };
  const lines = body.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (toggleFence(line, fence) || fence.open) continue;
    if (TABLE_ROW_RE.test(line) && i + 1 < lines.length && isTableSeparator(lines[i + 1]!)) {
      return true;
    }
  }
  return false;
}

function fenceLanguage(line: string): string {
  const match = line.match(FENCE_OPEN);
  if (!match) return "";
  return match[3]!.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
}

export function hasMermaidBlock(body: string): boolean {
  const fence: FenceState = { open: false, marker: "" };
  for (const line of body.split(/\r?\n/)) {
    if (!fence.open && fenceLanguage(line) === "mermaid") return true;
    toggleFence(line, fence);
  }
  return false;
}

export function mermaidBlocksMissingLeastCertain(body: string): boolean {
  const lines = body.split(/\r?\n/);
  const fence: FenceState = { open: false, marker: "" };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const startingMermaid = !fence.open && fenceLanguage(line) === "mermaid";
    if (toggleFence(line, fence)) {
      if (startingMermaid) {
        i++;
        while (i < lines.length && fence.open) {
          toggleFence(lines[i]!, fence);
          i++;
        }
        const after = lines.slice(i).join("\n");
        if (!LEAST_CERTAIN_FOLLOWING_RE.test(after)) return true;
        continue;
      }
      i++;
      continue;
    }
    i++;
  }
  return false;
}

export function comparisonLacksVisual(body: string): boolean {
  return !hasMarkdownTable(body) && !hasMermaidBlock(body);
}

function headingLevel(line: string): { level: number; title: string } | null {
  const match = line.match(HEADING_RE);
  if (!match) return null;
  return { level: match[1]!.length, title: match[2]!.trim() };
}

function collectListItem(lines: string[], start: number, markerRe: RegExp): { text: string; next: number } {
  const first = lines[start]!.replace(markerRe, "$2");
  const chunks = [first];
  let i = start + 1;
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) break;
    if (HEADING_RE.test(line) || FENCE_OPEN.test(line) || ORDERED_ITEM_RE.test(line) || UNORDERED_ITEM_RE.test(line) || TABLE_ROW_RE.test(line) || BLOCKQUOTE_RE.test(line)) {
      break;
    }
    if (/^\s+\S/.test(line)) {
      chunks.push(line.trim());
      i++;
      continue;
    }
    break;
  }
  return { text: chunks.join(" "), next: i };
}

export function findLongUnits(body: string): Array<{ text: string; words: number; limit: number }> {
  const lines = body.split(/\r?\n/);
  const fence: FenceState = { open: false, marker: "" };
  let underStepsUntilLevel: number | null = null;
  const findings: Array<{ text: string; words: number; limit: number }> = [];
  let paragraph: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    const text = paragraph.join(" ");
    paragraph = [];
    for (const sentence of splitSentences(text)) {
      const words = countWords(sentence);
      if (words > STE_PROSE_WORD_LIMIT) {
        findings.push({ text: sentence, words, limit: STE_PROSE_WORD_LIMIT });
      }
    }
  };

  const checkInstruction = (text: string) => {
    const words = countWords(text);
    if (words > STE_INSTRUCTION_WORD_LIMIT) {
      findings.push({ text, words, limit: STE_INSTRUCTION_WORD_LIMIT });
    }
  };

  const checkProseChunk = (text: string) => {
    for (const sentence of splitSentences(text)) {
      const words = countWords(sentence);
      if (words > STE_PROSE_WORD_LIMIT) {
        findings.push({ text: sentence, words, limit: STE_PROSE_WORD_LIMIT });
      }
    }
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (toggleFence(line, fence)) {
      flushParagraph();
      i++;
      continue;
    }
    if (fence.open) {
      i++;
      continue;
    }

    const heading = headingLevel(line);
    if (heading) {
      flushParagraph();
      if (STEPS_HEADING_RE.test(heading.title)) {
        underStepsUntilLevel = heading.level;
      } else if (underStepsUntilLevel !== null && heading.level <= underStepsUntilLevel) {
        underStepsUntilLevel = null;
      }
      i++;
      continue;
    }

    if (BLOCKQUOTE_RE.test(line) || TABLE_ROW_RE.test(line) || isTableSeparator(line)) {
      flushParagraph();
      i++;
      continue;
    }

    const ordered = line.match(ORDERED_ITEM_RE);
    if (ordered) {
      flushParagraph();
      const item = collectListItem(lines, i, ORDERED_ITEM_RE);
      checkInstruction(item.text);
      i = item.next;
      continue;
    }

    const unordered = line.match(UNORDERED_ITEM_RE);
    if (unordered) {
      flushParagraph();
      const item = collectListItem(lines, i, UNORDERED_ITEM_RE);
      if (underStepsUntilLevel !== null) checkInstruction(item.text);
      else checkProseChunk(item.text);
      i = item.next;
      continue;
    }

    if (!line.trim()) {
      flushParagraph();
      i++;
      continue;
    }

    paragraph.push(line.trim());
    i++;
  }
  flushParagraph();
  return findings;
}

export function hasSteSentenceLengthViolation(body: string): boolean {
  return findLongUnits(body).length > 0;
}

function stripInlineCodeSpans(text: string): string {
  return text.replace(/`[^`]*`/g, " ");
}

export function findHedgesOutsideAllowedRegions(body: string): string[] {
  const lines = body.split(/\r?\n/);
  const fence: FenceState = { open: false, marker: "" };
  let uncertaintyUntilLevel: number | null = null;
  let skippingLeastCertainList = false;
  const found: string[] = [];

  for (const line of lines) {
    if (toggleFence(line, fence)) {
      skippingLeastCertainList = false;
      continue;
    }
    if (fence.open) continue;

    const heading = headingLevel(line);
    if (heading) {
      skippingLeastCertainList = false;
      if (UNCERTAINTY_HEADING_RE.test(line)) {
        uncertaintyUntilLevel = heading.level;
      } else if (uncertaintyUntilLevel !== null && heading.level <= uncertaintyUntilLevel) {
        uncertaintyUntilLevel = null;
      }
      continue;
    }

    if (uncertaintyUntilLevel !== null || BLOCKQUOTE_RE.test(line)) {
      skippingLeastCertainList = false;
      continue;
    }

    if (LEAST_CERTAIN_RE.test(line)) {
      skippingLeastCertainList = true;
      continue;
    }

    if (skippingLeastCertainList) {
      if (!line.trim() || UNORDERED_ITEM_RE.test(line) || ORDERED_ITEM_RE.test(line) || /^\s+\S/.test(line)) {
        continue;
      }
      skippingLeastCertainList = false;
    }

    found.push(...findHedgeMatches(stripInlineCodeSpans(line)));
  }

  return [...new Set(found)];
}

export function hasSteHedgeViolation(body: string): boolean {
  return findHedgesOutsideAllowedRegions(body).length > 0;
}

export { HEDGE_PHRASES, HEDGE_WORDS };
