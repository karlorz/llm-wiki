export type {
  CheckStatus,
  CheckResult,
  DoctorOutput,
  DoctorInput,
  VaultSyncRuntimeConfig,
} from "../doctor/types.js";
export {
  DoctorRunner,
  runDoctor,
} from "../doctor/runner.js";
export { checkGrokActivation } from "../doctor/probes/skills-plugins.js";
export {
  checkSatelliteLastRun,
  checkSatelliteTimer,
  type SatelliteTimerDeps,
} from "../doctor/probes/satellite.js";
export {
  snapshotterHealthChecks,
  readVaultSyncConfig,
  PUSH_NOT_IN_PROFILE,
} from "../doctor/probes/vault-sync.js";
export { doctorReadOnlyScanRoot } from "../doctor/probes/metrics.js";
