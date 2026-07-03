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

const sessionPinPath = z.string().regex(
  /^(entities|concepts|comparisons|queries|meta)\/.+\.md$/,
  "must reference a typed-knowledge markdown page"
);

export const SessionPinSchema = z.object({
  title: z.string().min(1),
  path: sessionPinPath,
  scope: z.enum(["global", "project"]),
  project: wikilink.optional(),
  summary: z.string().min(1).optional(),
  updated: isoDate.optional()
}).superRefine((v, ctx) => {
  if (v.scope === "project" && v.project === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["project"],
      message: "project is required when scope is project"
    });
  }
});

export type SessionPin = z.infer<typeof SessionPinSchema>;

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
  generated_kind: z.enum(["session-brief"]).optional(),
  meta_kind: z.enum(["session-pins"]).optional(),
  stale_ttl: z.number().int().positive().optional(),
  pins: z.array(SessionPinSchema).optional()
}).superRefine((v, ctx) => {
  const isGeneratedSessionBrief = v.generated_kind === "session-brief";
  const isSessionPins = v.meta_kind === "session-pins";
  if (isSessionPins && (!v.pins || v.pins.length === 0)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["pins"], message: "required when meta_kind is session-pins" });
  }
  if (!isGeneratedSessionBrief && !isSessionPins && (!v.provenance_projects || v.provenance_projects.length < 2)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["provenance_projects"], message: "meta pages must reference ≥2 projects" });
  }
  if (v.provenance && v.provenance !== "research" && (!v.provenance_projects || v.provenance_projects.length === 0)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["provenance_projects"], message: "required when provenance != research" });
  }
});

export type Meta = z.infer<typeof MetaSchema>;

const hostId = z.string().regex(/^[a-z0-9][a-z0-9_-]*$/, "must be a lowercase host id");
const endpointName = z.string().min(1).regex(/^[A-Za-z0-9_.-]+$/, "must be a hostname-like token");
const ipAddress = z.string().min(1).regex(/^[0-9a-fA-F:.]+$/, "must be an IP address token");
const sshAlias = z.string().min(1).regex(/^[A-Za-z0-9_.@-]+$/, "must be an SSH alias token");
const sshUser = z.string().min(1).regex(/^[A-Za-z0-9_.-]+$/, "must be an SSH user token");
const absolutePath = z.string().min(1).regex(/^\//, "must be an absolute path");

export const FleetAccessProfileSchema = z.object({
  status: z.enum(["local", "configured", "planned", "absent", "unknown"]),
  ssh_aliases: z.array(sshAlias).optional(),
  users: z.array(sshUser).optional(),
  transports: z.array(z.enum(["local", "public-ip", "tailscale", "private-lan"])).min(1)
}).strict();

export type FleetAccessProfile = z.infer<typeof FleetAccessProfileSchema>;

export const FleetHostIdentitySchema = z.object({
  hostnames: z.array(endpointName).min(1),
  public_addresses: z.array(ipAddress).optional(),
  private_addresses: z.array(ipAddress).optional(),
  tailscale: z.object({
    node_names: z.array(endpointName).optional(),
    magicdns_names: z.array(endpointName).optional(),
    addresses: z.array(ipAddress).optional()
  }).strict().optional()
}).strict();

export type FleetHostIdentity = z.infer<typeof FleetHostIdentitySchema>;

export const FleetSkillwikiSatelliteSchema = z.object({
  enabled: z.boolean(),
  user: sshUser,
  vault_path: absolutePath,
  repo_path: absolutePath,
  ssh_alias: sshAlias,
  scheduler: z.enum(["systemd"]),
  timezone: z.string().min(1).optional(),
  jobs: z.array(z.enum([
    "self-update-check",
    "vault-sync-preflight",
    "agent-memory-trends-daily",
    "session-brief-refresh",
    "health-summary"
  ])).min(1),
  cadence: z.object({
    self_update_check: z.literal("every-4-hours").optional(),
    daily_window: z.string().min(1).optional()
  }).strict().optional()
}).strict();

export type FleetSkillwikiSatellite = z.infer<typeof FleetSkillwikiSatelliteSchema>;

export const FleetHostSchema = z.object({
  class: z.enum(["dev-macos", "dev-linux", "prod-linux", "unknown"]),
  role: z.enum(["leaf", "snapshotter"]),
  writes_to: z.array(z.enum(["s3", "github"])).min(1),
  protected: z.boolean().optional(),
  identity: FleetHostIdentitySchema,
  access: z.object({
    from: z.record(hostId, FleetAccessProfileSchema).optional()
  }).strict().optional(),
  maintenance: z.object({
    skillwiki_satellite: FleetSkillwikiSatelliteSchema.optional()
  }).strict().optional()
}).strict();

export type FleetHost = z.infer<typeof FleetHostSchema>;

export const FleetManifestSchema = z.object({
  "$schema": z.string().url().optional(),
  schema_version: z.literal(1),
  vault_remote: z.string().min(1),
  s3_remote: z.string().min(1).optional(),
  hosts: z.record(hostId, FleetHostSchema)
}).strict().superRefine((v, ctx) => {
  const entries = Object.entries(v.hosts);
  if (entries.length === 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["hosts"], message: "must contain at least one host" });
  }

  const snapshotters = entries.filter(([, host]) => host.role === "snapshotter").map(([id]) => id);
  if (snapshotters.length !== 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["hosts"],
      message: `must contain exactly one snapshotter host, found ${snapshotters.length}`
    });
  }
});

export type FleetManifest = z.infer<typeof FleetManifestSchema>;

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
