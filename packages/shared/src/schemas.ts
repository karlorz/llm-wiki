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
  type: z.enum(["entity", "concept", "comparison", "query"]),
  tags: z.array(z.string()),
  sources: z.array(z.string()).min(1),
  confidence: z.enum(["high", "medium", "low"]).optional(),
  contested: z.boolean().optional(),
  contradictions: z.array(z.string()).optional(),
  provenance: z.enum(["research", "project", "mixed"]).optional(),
  provenance_projects: z.array(wikilink).optional(),
  work_items: z.array(wikilink).optional(),
  stale_ttl: z.number().int().positive().optional()
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
  created: isoDate.optional(),
  ingested: isoDate,
  ingested_by: z.enum(["wiki-ingest", "proj-work", "manual"]).optional(),
  sha256: sha256Hex.optional(),
  project: wikilink.optional(),
  work_item: wikilink.optional(),
  kind: z.enum(["postmortem", "session-log", "meeting-notes", "other", "idea", "bug", "task", "note"]).optional()
}).superRefine((v, ctx) => {
  if (v.work_item !== undefined && (v.project === undefined || v.kind === undefined)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "project and kind are required when work_item is set" });
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
  provenance_projects: z.array(wikilink).optional(),
  generated_by: z.string().min(1).optional(),
  generated_at: z.string().datetime().optional(),
  generated_kind: z.enum(["session-brief"]).optional()
}).superRefine((v, ctx) => {
  if (v.generated_kind !== "session-brief" && (!v.provenance_projects || v.provenance_projects.length < 2)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["provenance_projects"], message: "meta pages must reference ≥2 projects" });
  }
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
  // Raw sources (ingested with source_url field, or ad-hoc capture with kind)
  if ("ingested" in fm && ("source_url" in fm || "sha256" in fm)) return { schema: "raw" };
  const RAW_KINDS = new Set(["postmortem", "session-log", "meeting-notes", "other", "idea", "bug", "task", "note"]);
  if ("ingested" in fm && typeof fm.kind === "string" && RAW_KINDS.has(fm.kind)) return { schema: "raw" };
  // Work items
  if ("kind" in fm && "status" in fm) return { schema: "work-item" };
  return { schema: null };
}
