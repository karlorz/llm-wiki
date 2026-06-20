import { ok, type OkResult } from "./json-output.js";

export type SessionKind = "interactive" | "headless" | "goal" | "satellite";

export type SessionDefaultPolicy =
  | "prompt"
  | "recorded-defaults-or-fail"
  | "automation-ready-or-skip"
  | "profile-allowed-or-fail";

export interface SessionKindInput {
  env?: Record<string, string | undefined>;
  spawned?: boolean;
  noTty?: boolean;
  codexExec?: boolean;
  goalContext?: boolean;
  nonInteractiveGoal?: boolean;
  satelliteHostId?: string;
  maintenanceMode?: string;
}

export interface SessionKindResolution {
  kind: SessionKind;
  mayPrompt: boolean;
  defaultPolicy: SessionDefaultPolicy;
  defaultSourceRequired: boolean;
  reason: string;
  evidence: string[];
}

export type SessionKindResult = OkResult<SessionKindResolution>;

export function resolveSessionKind(input: SessionKindInput = {}): SessionKindResult {
  const env = input.env ?? {};
  const evidence: string[] = [];

  const hasSatellite = Boolean(input.satelliteHostId || input.maintenanceMode || env.SKILLWIKI_MAINTENANCE_HOST);
  if (hasSatellite) {
    if (input.satelliteHostId) evidence.push(`satelliteHostId:${input.satelliteHostId}`);
    if (input.maintenanceMode) evidence.push(`maintenanceMode:${input.maintenanceMode}`);
    if (env.SKILLWIKI_MAINTENANCE_HOST) evidence.push("env:SKILLWIKI_MAINTENANCE_HOST");
    return ok({
      kind: "satellite",
      mayPrompt: false,
      defaultPolicy: "profile-allowed-or-fail",
      defaultSourceRequired: true,
      reason: "scheduled or host-scoped satellite maintenance must not prompt",
      evidence,
    });
  }

  if (input.nonInteractiveGoal || input.goalContext) {
    if (input.nonInteractiveGoal) evidence.push("nonInteractiveGoal");
    if (input.goalContext) evidence.push("goalContext");
    return ok({
      kind: "goal",
      mayPrompt: false,
      defaultPolicy: "automation-ready-or-skip",
      defaultSourceRequired: true,
      reason: "/goal continuation must not prompt",
      evidence,
    });
  }

  const headlessSignals = [
    input.spawned ? "spawned" : "",
    input.noTty ? "noTty" : "",
    input.codexExec ? "codexExec" : "",
    env.CI ? "env:CI" : "",
    env.OPENCLAW_SESSION ? "env:OPENCLAW_SESSION" : "",
    env.SPAWNED_SESSION ? "env:SPAWNED_SESSION" : "",
  ].filter(Boolean);

  if (headlessSignals.length > 0) {
    return ok({
      kind: "headless",
      mayPrompt: false,
      defaultPolicy: "recorded-defaults-or-fail",
      defaultSourceRequired: true,
      reason: "headless or spawned execution must not prompt",
      evidence: headlessSignals,
    });
  }

  return ok({
    kind: "interactive",
    mayPrompt: true,
    defaultPolicy: "prompt",
    defaultSourceRequired: false,
    reason: "no non-interactive evidence detected",
    evidence,
  });
}
