import type { DoctorProbe } from "../types.js";
import { environmentProbe } from "./environment.js";
import { vaultStructureProbe } from "./vault-structure.js";
import { gitFleetProbe } from "./git-fleet.js";
import { hygieneProbe } from "./hygiene.js";
import { s3MountHealthProbe } from "./s3-mount-health.js";
import { skillsPluginsProbe } from "./skills-plugins.js";
import { vaultSyncProbe } from "./vault-sync.js";
import { satelliteProbe } from "./satellite.js";
import { metricsProbe } from "./metrics.js";
import { fuseStalenessProbe } from "./fuse-staleness.js";
import { activationMarkerProbe } from "./activation-marker.js";
import { dsStoreNoiseProbe } from "./ds-store-noise.js";

export const DOCTOR_PROBES: readonly DoctorProbe[] = [
  environmentProbe,
  vaultStructureProbe,
  gitFleetProbe,
  hygieneProbe,
  s3MountHealthProbe,
  skillsPluginsProbe,
  vaultSyncProbe,
  satelliteProbe,
  metricsProbe,
  fuseStalenessProbe,
  activationMarkerProbe,
  dsStoreNoiseProbe,
];
