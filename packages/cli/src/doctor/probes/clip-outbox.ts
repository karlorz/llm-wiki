import { existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { platform } from "node:os";
import { join } from "node:path";
import type { CheckResult, DoctorContext, DoctorProbe } from "../types.js";
import { check, MCP_ONLY_LEAF_SKIP } from "./helpers.js";
import {
  CLIP_NOT_CONFIGURED,
  PRODUCTION_WATCHER_LABEL,
  RETIRED_WATCHER_LABELS,
  loadClipOutboxConfig,
} from "../../utils/clip-outbox-config.js";

export const CLIP_CHECK_IDS = [
  "clip_config",
  "clip_frozen_mirror",
  "clip_push_isolation",
  "clip_outbox_root",
  "clip_watcher",
  "clip_storage_credentials",
  "clip_ready_channel",
  "clip_mirror_listener",
] as const;

function notConfigured(): CheckResult[] {
  return CLIP_CHECK_IDS.map((id) =>
    check("info", id, clipLabel(id), CLIP_NOT_CONFIGURED),
  );
}

function clipLabel(id: string): string {
  switch (id) {
    case "clip_config": return "Clip outbox configuration";
    case "clip_frozen_mirror": return "Clip frozen mirror";
    case "clip_push_isolation": return "Clip push isolation";
    case "clip_outbox_root": return "Clip outbox root";
    case "clip_watcher": return "Clip outbox watcher";
    case "clip_storage_credentials": return "Clip storage credentials";
    case "clip_ready_channel": return "Clip ready channel";
    case "clip_mirror_listener": return "Clip mirror listener";
    default: return id;
  }
}

function launchdLoaded(label: string): boolean {
  if (platform() !== "darwin") return false;
  try {
    execSync(`launchctl list ${label}`, {
      encoding: "utf8", timeout: 2000, stdio: ["pipe", "ignore", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

function watcherStatus(env: NodeJS.ProcessEnv, label: string): { loaded: boolean; enabled: boolean; kind: "production" | "retired" | "unknown" } {
  const fixture = env.CLIP_WATCHER_FIXTURE;
  if (fixture === "loaded-enabled") return { loaded: true, enabled: true, kind: "production" };
  if (fixture === "stopped") return { loaded: false, enabled: false, kind: "production" };
  if (fixture === "retired-wiki-dev") return { loaded: true, enabled: true, kind: "retired" };
  if (fixture === "missing") return { loaded: false, enabled: false, kind: "unknown" };

  if (RETIRED_WATCHER_LABELS.includes(label as typeof RETIRED_WATCHER_LABELS[number])) {
    return { loaded: false, enabled: false, kind: "retired" };
  }
  if (!launchdLoaded(label)) {
    return { loaded: false, enabled: false, kind: "unknown" };
  }
  const plist = join(process.env.HOME ?? "", "Library", "LaunchAgents", `${label}.plist`);
  return { loaded: true, enabled: existsSync(plist), kind: "production" };
}

function pushLoaded(env: NodeJS.ProcessEnv): boolean {
  if (env.CLIP_PUSH_FIXTURE === "loaded") return true;
  if (env.CLIP_PUSH_FIXTURE === "unloaded") return false;
  return launchdLoaded("com.karlchow.wiki-push");
}

function credentialPresent(env: NodeJS.ProcessEnv, ref: string): boolean {
  if (env.CLIP_CREDENTIAL_FIXTURE === "present") return true;
  if (env.CLIP_CREDENTIAL_FIXTURE === "absent") return false;
  const value = env[ref];
  return typeof value === "string" && value.length > 0;
}

function listenerOk(env: NodeJS.ProcessEnv): boolean {
  if (env.CLIP_LISTENER_FIXTURE === "ok") return true;
  return false;
}

function conditionalCreateEvidence(env: NodeJS.ProcessEnv): boolean {
  return env.CLIP_CONDITIONAL_CREATE_FIXTURE === "ok";
}

export const clipOutboxProbe: DoctorProbe = {
  id: "clip_outbox",
  async run(ctx: DoctorContext): Promise<CheckResult[]> {
    if (ctx.mcpOnlyLeaf) {
      return CLIP_CHECK_IDS.map((id) =>
        check("info", id, clipLabel(id), MCP_ONLY_LEAF_SKIP),
      );
    }
    const env = ctx.input.env ?? process.env;
    const resolved = await loadClipOutboxConfig(ctx.input.home);
    if (!resolved.ok) {
      return [
        check("error", "clip_config", clipLabel("clip_config"), resolved.message),
        ...CLIP_CHECK_IDS.slice(1).map((id) => check("error", id, clipLabel(id), "clip configuration invalid")),
      ];
    }
    if (!resolved.enabled) {
      return notConfigured();
    }
    const cfg = resolved.config;
    const frozen = existsSync(join(cfg.mirrorRoot, ".WIKI_GIT_FROZEN"));
    const pushOn = ctx.vsConfig.pushEnabled !== false;
    const pushIsLoaded = pushLoaded(env);
    const watch = watcherStatus(env, cfg.watcherLabel);
    const s3Creds = credentialPresent(env, cfg.s3CredentialRef);
    const readyCreds = credentialPresent(env, cfg.readyCredentialRef);
    const condCreate = conditionalCreateEvidence(env);
    const listener = listenerOk(env);

    return [
      check("pass", "clip_config", clipLabel("clip_config"), "clip_outbox.enabled=true; schema valid"),
      frozen
        ? check("pass", "clip_frozen_mirror", clipLabel("clip_frozen_mirror"), "frozen marker present")
        : check("error", "clip_frozen_mirror", clipLabel("clip_frozen_mirror"), "frozen marker missing; do not unfreeze"),
      !pushOn && !pushIsLoaded
        ? check("pass", "clip_push_isolation", clipLabel("clip_push_isolation"), "wiki-push disabled and unloaded")
        : check("error", "clip_push_isolation", clipLabel("clip_push_isolation"), "wiki-push must stay disabled and unloaded"),
      check("pass", "clip_outbox_root", clipLabel("clip_outbox_root"), "outbox and state roots are canonical and disjoint"),
      watch.kind === "retired"
        ? check("error", "clip_watcher", clipLabel("clip_watcher"), "retired wiki-dev or D8 job does not satisfy the clip watcher")
        : watch.loaded && watch.enabled && watch.kind === "production"
          ? check("pass", "clip_watcher", clipLabel("clip_watcher"), `loaded and enabled: ${PRODUCTION_WATCHER_LABEL}`)
          : check("error", "clip_watcher", clipLabel("clip_watcher"), "production clip watcher not loaded and enabled"),
      s3Creds && readyCreds && condCreate
        ? check("pass", "clip_storage_credentials", clipLabel("clip_storage_credentials"), "credential references present; conditional-create evidence available")
        : check("error", "clip_storage_credentials", clipLabel("clip_storage_credentials"), "missing credential reference or conditional-create evidence"),
      readyCreds
        ? check("pass", "clip_ready_channel", clipLabel("clip_ready_channel"), "ready URL and credential reference present")
        : check("error", "clip_ready_channel", clipLabel("clip_ready_channel"), "ready credential missing"),
      listener
        ? check("pass", "clip_mirror_listener", clipLabel("clip_mirror_listener"), "inbound production SSE listener configured")
        : check("error", "clip_mirror_listener", clipLabel("clip_mirror_listener"), "inbound SSE listener disabled or missing"),
    ];
  },
};
