import { z } from "zod";

export const isoDate = z.string().refine((s) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + "T00:00:00Z");
  return !Number.isNaN(d.getTime()) && s === d.toISOString().slice(0, 10);
}, { message: "must be YYYY-MM-DD" });

const wikilink = z.string().regex(/^\[\[[^\[\]]+\]\]$/, "must be \"[[name]]\"");

export const TypedKnowledgeSchema = z.object({
  title: z.string().min(1),
  aliases: z.array(z.string()).optional(),
  created: isoDate,
  updated: isoDate,
  type: z.enum(["entity", "concept", "comparison", "query", "summary"]),
  tags: z.array(z.string()),
  sources: z.array(z.string()).min(1),
  confidence: z.enum(["high", "medium", "low"]).optional(),
  contested: z.boolean().optional(),
  contradictions: z.array(z.string()).optional(),
  provenance: z.enum(["research", "project", "mixed"]).optional(),
  provenance_projects: z.array(wikilink).optional(),
  work_items: z.array(wikilink).optional()
}).superRefine((v, ctx) => {
  if (v.provenance && v.provenance !== "research" && (!v.provenance_projects || v.provenance_projects.length === 0)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["provenance_projects"], message: "required when provenance != research" });
  }
});

export type TypedKnowledge = z.infer<typeof TypedKnowledgeSchema>;

const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);

export const RawSourceSchema = z.object({
  title: z.string().min(1).optional(),
  source_url: z.string().nullable(),
  ingested: isoDate,
  ingested_by: z.enum(["wiki-ingest", "proj-work", "manual"]).optional(),
  sha256: sha256Hex,
  project: wikilink.optional(),
  work_item: wikilink.optional(),
  kind: z.enum(["postmortem", "session-log", "meeting-notes", "other"]).optional()
}).superRefine((v, ctx) => {
  const projectFields = [v.project, v.work_item, v.kind];
  const present = projectFields.filter((x) => x !== undefined).length;
  if (present !== 0 && present !== 3) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "project, work_item, kind must all be set together" });
  }
});

export type RawSource = z.infer<typeof RawSourceSchema>;

export const WorkItemSchema = z.object({
  title: z.string().min(1),
  aliases: z.array(z.string()).optional(),
  created: isoDate,
  updated: isoDate,
  started: isoDate,
  completed: isoDate.optional(),
  kind: z.enum(["feature", "issue", "refactor", "decision"]),
  status: z.enum(["planned", "in-progress", "completed", "abandoned"]),
  priority: z.enum(["high", "medium", "low"]),
  project: wikilink,
  owner: wikilink.optional(),
  parent: wikilink.optional(),
  related: z.array(wikilink).optional(),
  sources: z.array(z.string()).optional()
}).superRefine((v, ctx) => {
  if (v.status === "completed" && !v.completed) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["completed"], message: "required when status is completed" });
  }
});

export type WorkItem = z.infer<typeof WorkItemSchema>;

export const CompoundSchema = z.object({
  title: z.string().min(1),
  aliases: z.array(z.string()).optional(),
  created: isoDate,
  updated: isoDate,
  type: z.enum(["lesson", "pattern", "antipattern", "gotcha"]),
  tags: z.array(z.string()),
  confidence: z.enum(["high", "medium", "low"]),
  contradicts: z.array(z.string()).optional(),
  project: wikilink,
  work_items: z.array(wikilink).min(1),
  promoted_to: wikilink.optional(),
  cssclasses: z.array(z.string()).optional()
});

export type Compound = z.infer<typeof CompoundSchema>;

export const MetaSchema = z.object({
  title: z.string().min(1),
  aliases: z.array(z.string()).optional(),
  created: isoDate,
  updated: isoDate,
  type: z.literal("meta"),
  tags: z.array(z.string()),
  confidence: z.enum(["high", "medium", "low"]).optional(),
  provenance: z.enum(["research", "project", "mixed"]).optional(),
  provenance_projects: z.array(wikilink).min(2, "meta pages must reference ≥2 projects")
}).superRefine((v, ctx) => {
  if (v.provenance && v.provenance !== "research" && (!v.provenance_projects || v.provenance_projects.length === 0)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["provenance_projects"], message: "required when provenance != research" });
  }
});

export type Meta = z.infer<typeof MetaSchema>;

export type SchemaName = "typed-knowledge" | "raw" | "work-item" | "compound" | "meta";

export function detectSchema(fm: Record<string, unknown>): { schema: SchemaName | null } {
  const COMPOUND_TYPES = new Set(["lesson", "pattern", "antipattern", "gotcha"]);

  // Check compound first (has project + known compound type)
  if (typeof fm.type === "string" && COMPOUND_TYPES.has(fm.type) && "project" in fm) return { schema: "compound" };
  // Meta pages (type=meta, cross-project synthesis)
  if (fm.type === "meta") return { schema: "meta" };
  // Then typed-knowledge (has type + sources — let Zod validate the specific type value)
  if ("type" in fm && "sources" in fm) return { schema: "typed-knowledge" };
  // Raw sources
  if (typeof fm.sha256 === "string" && "ingested" in fm) return { schema: "raw" };
  // Work items
  if ("kind" in fm && "status" in fm) return { schema: "work-item" };
  return { schema: null };
}
