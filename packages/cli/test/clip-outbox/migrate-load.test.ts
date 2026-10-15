import { describe, expect, it, vi } from "vitest";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { clipFixture } from "./fixture.js";
vi.mock("../../src/clip-outbox/runtime.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/clip-outbox/runtime.js")>(),
  loadClipCredentials: vi.fn(async () => ({ s3: { endpoint: "https://storage.example.com" }, readyToken: "fixture" })),
  validateRuntime: vi.fn(async () => {}),
}));
import { migrateClipOutbox } from "../../src/clip-outbox/migrate.js";
import { validateRuntime } from "../../src/clip-outbox/runtime.js";

describe.skipIf(process.platform === "win32")("operator-gated load", () => {
  it("records endpoint-bound attestation and loads only after runtime validation", async () => {
    const { home, config } = await clipFixture();
    const launch = vi.fn();
    const result = await migrateClipOutbox({ home, platform: "darwin", load: true, conditionalCreateProven: true, binaryPath: "/opt/homebrew/bin/skillwiki", launch });
    expect(result.loaded).toBe(true);
    expect(result.mirrorLoaded).toBe(false);
    expect(validateRuntime).toHaveBeenCalled();
    const proof = JSON.parse(await readFile(join(config.stateRoot, "conditional-create.json"), "utf8"));
    expect(proof).toMatchObject({ verified: true, endpoint: "https://storage.example.com", destination: "seaweed-wiki:cloud/wiki" });
    expect(launch.mock.calls.map(([args]) => args[0])).toEqual(["bootout", "enable", "bootstrap"]);
    expect(await readFile(join(home, ".skillwiki/.env"), "utf8")).toContain("clip_outbox.enabled=true");
    await rm(home, { recursive: true });
  });
});
