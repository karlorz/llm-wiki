import { describe, expect, it } from "vitest";
import { ReconcileGate, ToolsNotReadyError } from "../src/reconcile.js";

describe("reconcile gate", () => {
  it("blocks tools until the first inbound copy completes", async () => {
    let resolveCopy!: () => void;
    const started = new Promise<void>((resolve) => {
      resolveCopy = resolve;
    });
    const gate = new ReconcileGate(async () => {
      await started;
    });
    expect(gate.ready).toBe(false);
    expect(() => gate.assertReady()).toThrow(ToolsNotReadyError);
    const first = gate.runFirst();
    await new Promise((r) => setTimeout(r, 10));
    expect(gate.ready).toBe(false);
    resolveCopy();
    await first;
    expect(gate.ready).toBe(true);
    expect(() => gate.assertReady()).not.toThrow();
  });
});
