import { ensureApprovedJobOrder, type MaintenanceConfig } from "./config.js";
import { err, ok, type MaintenanceJobId, type MaintenanceMode, type Result } from "./types.js";

export type WorkflowProfileId =
  | "attended-full"
  | "unattended-daily"
  | "self-update-check"
  | "self-update-apply";

export interface ResolvedWorkflowProfile {
  id: WorkflowProfileId;
  mode: MaintenanceMode;
  selectedJobs: MaintenanceJobId[];
  readOnlyJobs: MaintenanceJobId[];
  writerJobs: MaintenanceJobId[];
  runsSelfUpdateCheck: boolean;
  runsPreflight: boolean;
  runsSelfUpdateApply: boolean;
  pushAfterCommittedWriter: boolean;
}

interface WorkflowProfileDefinition {
  id: WorkflowProfileId;
  selectedJobs: MaintenanceJobId[];
  readOnlyJobs: MaintenanceJobId[];
  writerJobs: MaintenanceJobId[];
  runsSelfUpdateCheck: boolean;
  runsPreflight: boolean;
  runsSelfUpdateApply: boolean;
  pushAfterCommittedWriter: boolean;
}

const PROFILE_DEFINITIONS: Record<MaintenanceMode, WorkflowProfileDefinition> = {
  full: {
    id: "attended-full",
    selectedJobs: ["agent-memory-trends-daily", "session-brief-refresh", "health-summary"],
    readOnlyJobs: ["health-summary"],
    writerJobs: ["agent-memory-trends-daily", "session-brief-refresh"],
    runsSelfUpdateCheck: true,
    runsPreflight: true,
    runsSelfUpdateApply: false,
    pushAfterCommittedWriter: false,
  },
  daily: {
    id: "unattended-daily",
    selectedJobs: ["agent-memory-trends-daily", "health-summary"],
    readOnlyJobs: ["health-summary"],
    writerJobs: ["agent-memory-trends-daily"],
    runsSelfUpdateCheck: false,
    runsPreflight: true,
    runsSelfUpdateApply: false,
    pushAfterCommittedWriter: true,
  },
  "self-update": {
    id: "self-update-check",
    selectedJobs: [],
    readOnlyJobs: [],
    writerJobs: [],
    runsSelfUpdateCheck: true,
    runsPreflight: false,
    runsSelfUpdateApply: false,
    pushAfterCommittedWriter: false,
  },
  "self-update-apply": {
    id: "self-update-apply",
    selectedJobs: [],
    readOnlyJobs: [],
    writerJobs: [],
    runsSelfUpdateCheck: false,
    runsPreflight: true,
    runsSelfUpdateApply: true,
    pushAfterCommittedWriter: false,
  },
};

export function resolveWorkflowProfile(config: MaintenanceConfig, mode: MaintenanceMode): Result<ResolvedWorkflowProfile> {
  const definition = PROFILE_DEFINITIONS[mode];
  if (!definition) return err("CONFIG_INVALID", `unsupported maintenance mode: ${mode}`);

  const approvedJobs = ensureApprovedJobOrder(config.jobs);
  if (!approvedJobs.ok) return approvedJobs;

  if (!definition.writerJobs.every((job) => definition.selectedJobs.includes(job))) {
    return err("CONFIG_INVALID", `profile ${definition.id} declares writers outside its selected jobs`);
  }

  if (!definition.readOnlyJobs.every((job) => definition.selectedJobs.includes(job))) {
    return err("CONFIG_INVALID", `profile ${definition.id} declares read-only jobs outside its selected jobs`);
  }

  if (definition.readOnlyJobs.some((job) => definition.writerJobs.includes(job))) {
    return err("CONFIG_INVALID", `profile ${definition.id} marks the same job as read-only and writing`);
  }

  const mutatesHost = definition.writerJobs.length > 0 || definition.runsSelfUpdateApply;
  if (config.protectedHost && mutatesHost) {
    return err("CONFIG_INVALID", `profile ${definition.id} cannot mutate protected host ${config.hostId}`);
  }

  return ok({
    id: definition.id,
    mode,
    selectedJobs: [...definition.selectedJobs],
    readOnlyJobs: [...definition.readOnlyJobs],
    writerJobs: [...definition.writerJobs],
    runsSelfUpdateCheck: definition.runsSelfUpdateCheck,
    runsPreflight: definition.runsPreflight,
    runsSelfUpdateApply: definition.runsSelfUpdateApply,
    pushAfterCommittedWriter: definition.pushAfterCommittedWriter,
  });
}
