import { describe, it, expect } from "vitest";
import { DoctorRunner } from "../../src/doctor/runner.js";
import { DOCTOR_PROBES } from "../../src/doctor/probes/index.js";
import type { CheckResult, DoctorContext, DoctorProbe } from "../../src/doctor/types.js";

describe("DoctorRunner probe registry and execution", () => {
  it("registers all standard probe modules in order", () => {
    const runner = new DoctorRunner();
    const probes = runner.getRegisteredProbes();
    expect(probes.length).toBe(DOCTOR_PROBES.length);

    const probeIds = probes.map(p => p.id);
    expect(probeIds).toEqual([
      "environment",
      "vault_structure",
      "git_fleet",
      "hygiene",
      "s3_mount_health",
      "skills_plugins",
      "vault_sync",
      "satellite",
      "metrics",
      "fuse_staleness",
      "activation_marker",
      "ds_store_noise",
    ]);
  });

  it("supports custom probe registration in custom DoctorRunner instance", async () => {
    const customProbe: DoctorProbe = {
      id: "custom_probe",
      run(ctx: DoctorContext): CheckResult[] {
        return [
          {
            id: "custom_check_id",
            label: "Custom Check",
            status: "pass",
            detail: `custom detail for ${ctx.input.home}`,
          },
        ];
      },
    };

    const runner = new DoctorRunner([...DOCTOR_PROBES, customProbe]);
    expect(runner.getRegisteredProbes().map(p => p.id)).toContain("custom_probe");
  });
});
