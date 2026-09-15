import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileOAuthStore } from "../src/oauth-store.js";

describe("FileOAuthStore persist fail-closed", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "oauth-store-fail-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("rolls back in-memory state and leaves no token file when persist fails", async () => {
    const store = new FileOAuthStore(tmpDir);
    await mkdir(join(tmpDir, "oauth-store.json"));

    await expect(store.saveClient({
      clientId: "c1",
      redirectUris: ["http://localhost/cb"],
    })).rejects.toThrow();
    expect(await store.getClient("c1")).toBeNull();

    const tokenHash = createHash("sha256").update("access-secret", "utf8").digest("hex");
    await expect(store.saveAccessToken({
      tokenHash,
      clientId: "c1",
      writerId: "writer-test",
      expiresAt: Date.now() + 3600_000,
    })).rejects.toThrow();
    expect(await store.getAccessToken(tokenHash)).toBeNull();

    const reloaded = new FileOAuthStore(tmpDir);
    expect(await reloaded.getClient("c1")).toBeNull();
    expect(await reloaded.getAccessToken(tokenHash)).toBeNull();
  });
});
