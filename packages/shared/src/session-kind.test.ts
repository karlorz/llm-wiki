import { describe, expect, it } from "vitest";
import { resolveSessionKind } from "./session-kind.js";

describe("resolveSessionKind", () => {
  it("defaults to interactive when no non-interactive evidence is present", () => {
    expect(resolveSessionKind({}).data).toMatchObject({
      kind: "interactive",
      mayPrompt: true,
      defaultPolicy: "prompt",
      defaultSourceRequired: false,
    });
  });

  it("resolves headless from spawned or CI evidence", () => {
    expect(resolveSessionKind({ spawned: true }).data).toMatchObject({
      kind: "headless",
      mayPrompt: false,
      defaultPolicy: "recorded-defaults-or-fail",
      defaultSourceRequired: true,
    });
    expect(resolveSessionKind({ env: { CI: "true" } }).data.kind).toBe("headless");
  });

  it("resolves goal from goal-context evidence", () => {
    expect(resolveSessionKind({ goalContext: true }).data).toMatchObject({
      kind: "goal",
      mayPrompt: false,
      defaultPolicy: "automation-ready-or-skip",
      defaultSourceRequired: true,
    });
  });

  it("resolves satellite from maintenance host evidence", () => {
    expect(resolveSessionKind({ satelliteHostId: "sg02", maintenanceMode: "daily" }).data).toMatchObject({
      kind: "satellite",
      mayPrompt: false,
      defaultPolicy: "profile-allowed-or-fail",
      defaultSourceRequired: true,
    });
  });

  it("gives satellite precedence over goal and headless signals", () => {
    expect(
      resolveSessionKind({
        satelliteHostId: "sg02",
        maintenanceMode: "daily",
        goalContext: true,
        env: { CI: "true" },
      }).data.kind
    ).toBe("satellite");
  });
});
