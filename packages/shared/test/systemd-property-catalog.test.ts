import { describe, expect, it } from "vitest";
import {
  SYSTEMD_PROPERTY_CATALOG,
  systemdPropertyFor,
} from "../src/systemd-property-catalog.js";

describe("systemd property catalog", () => {
  it("maps health semantics to case-sensitive live properties", () => {
    expect(SYSTEMD_PROPERTY_CATALOG).toMatchObject({
      active_state: "ActiveState",
      next_elapse: "NextElapseUSecRealtime",
      result: "Result",
      exec_main_status: "ExecMainStatus",
      active_enter_timestamp: "ActiveEnterTimestamp",
      inactive_enter_timestamp: "InactiveEnterTimestamp",
      exec_main_start_timestamp: "ExecMainStartTimestamp",
      exec_main_exit_timestamp: "ExecMainExitTimestamp",
    });
  });

  it("fails closed for fixture-style or unknown property names", () => {
    expect(systemdPropertyFor("ActiveState")).toBeUndefined();
    expect(systemdPropertyFor("unknown_property")).toBeUndefined();
  });
});
