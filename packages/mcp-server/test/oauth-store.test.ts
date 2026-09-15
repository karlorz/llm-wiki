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

describe("FileOAuthStore grant management", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "oauth-store-grant-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("listClients returns saved clients", async () => {
    const store = new FileOAuthStore(tmpDir);
    expect(await store.listClients()).toEqual([]);

    await store.saveClient({ clientId: "c1", redirectUris: ["https://a.com/cb"] });
    await store.saveClient({ clientId: "c2", redirectUris: ["https://b.com/cb"] });

    const clients = await store.listClients();
    expect(clients).toHaveLength(2);
    expect(clients.map((c) => c.clientId).sort()).toEqual(["c1", "c2"]);
  });

  it("listRefreshTokens drops expired entries and keeps active ones", async () => {
    const store = new FileOAuthStore(tmpDir);
    await store.saveRefreshToken({
      tokenHash: "expired",
      clientId: "c1",
      writerId: "w1",
      expiresAt: Date.now() - 1000,
    });
    await store.saveRefreshToken({
      tokenHash: "active",
      clientId: "c1",
      writerId: "w1",
      expiresAt: Date.now() + 60_000,
    });

    const tokens = await store.listRefreshTokens();
    expect(tokens).toHaveLength(1);
    expect(tokens[0].tokenHash).toBe("active");
  });

  it("revokeRefreshToken returns true then false on repeat; other clients' tokens untouched", async () => {
    const store = new FileOAuthStore(tmpDir);
    await store.saveRefreshToken({
      tokenHash: "rt1",
      clientId: "c1",
      writerId: "w1",
      expiresAt: Date.now() + 60_000,
    });
    await store.saveRefreshToken({
      tokenHash: "rt2",
      clientId: "c2",
      writerId: "w2",
      expiresAt: Date.now() + 60_000,
    });

    expect(await store.revokeRefreshToken("rt1")).toBe(true);
    expect(await store.revokeRefreshToken("rt1")).toBe(false);

    const remaining = await store.listRefreshTokens();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].tokenHash).toBe("rt2");
  });

  it("revokeClient cascade: removes client + its codes/access/refresh tokens, returns correct grantsRemoved count, leaves other clients intact", async () => {
    const store = new FileOAuthStore(tmpDir);
    await store.saveClient({ clientId: "c1", redirectUris: ["https://c1.com"] });
    await store.saveClient({ clientId: "c2", redirectUris: ["https://c2.com"] });

    await store.saveAuthCode({
      codeHash: "code-c1",
      clientId: "c1",
      redirectUri: "https://c1.com",
      codeChallenge: "ch1",
      codeChallengeMethod: "S256",
      writerId: "w1",
      expiresAt: Date.now() + 60_000,
    });
    await store.saveAuthCode({
      codeHash: "code-c2",
      clientId: "c2",
      redirectUri: "https://c2.com",
      codeChallenge: "ch2",
      codeChallengeMethod: "S256",
      writerId: "w2",
      expiresAt: Date.now() + 60_000,
    });

    await store.saveAccessToken({
      tokenHash: "at-c1-1",
      clientId: "c1",
      writerId: "w1",
      expiresAt: Date.now() + 60_000,
    });
    await store.saveAccessToken({
      tokenHash: "at-c1-2",
      clientId: "c1",
      writerId: "w1",
      expiresAt: Date.now() + 60_000,
    });
    await store.saveAccessToken({
      tokenHash: "at-c2",
      clientId: "c2",
      writerId: "w2",
      expiresAt: Date.now() + 60_000,
    });

    await store.saveRefreshToken({
      tokenHash: "rt-c1-1",
      clientId: "c1",
      writerId: "w1",
      expiresAt: Date.now() + 60_000,
    });
    await store.saveRefreshToken({
      tokenHash: "rt-c1-2",
      clientId: "c1",
      writerId: "w1",
      expiresAt: Date.now() + 60_000,
    });
    await store.saveRefreshToken({
      tokenHash: "rt-c2",
      clientId: "c2",
      writerId: "w2",
      expiresAt: Date.now() + 60_000,
    });

    const res = await store.revokeClient("c1");
    expect(res).toEqual({ grantsRemoved: 2 });

    expect(await store.getClient("c1")).toBeNull();
    expect(await store.consumeAuthCode("code-c1")).toBeNull();
    expect(await store.getAccessToken("at-c1-1")).toBeNull();
    expect(await store.getAccessToken("at-c1-2")).toBeNull();

    expect(await store.getClient("c2")).not.toBeNull();
    expect(await store.consumeAuthCode("code-c2")).not.toBeNull();
    expect(await store.getAccessToken("at-c2")).not.toBeNull();

    const remainingRefresh = await store.listRefreshTokens();
    expect(remainingRefresh).toHaveLength(1);
    expect(remainingRefresh[0].tokenHash).toBe("rt-c2");
  });

  it("round-trip persistence: save -> mutate (revoke) -> reload from disk -> list reflects mutation", async () => {
    const store = new FileOAuthStore(tmpDir);
    await store.saveClient({ clientId: "c1", redirectUris: ["https://c1.com"] });
    await store.saveClient({ clientId: "c2", redirectUris: ["https://c2.com"] });
    await store.saveRefreshToken({
      tokenHash: "rt1",
      clientId: "c1",
      writerId: "w1",
      expiresAt: Date.now() + 60_000,
    });
    await store.saveRefreshToken({
      tokenHash: "rt2",
      clientId: "c2",
      writerId: "w2",
      expiresAt: Date.now() + 60_000,
    });

    // Revoke refresh token rt1
    expect(await store.revokeRefreshToken("rt1")).toBe(true);

    // Reload store from disk
    const reloaded1 = new FileOAuthStore(tmpDir);
    const rtList1 = await reloaded1.listRefreshTokens();
    expect(rtList1).toHaveLength(1);
    expect(rtList1[0].tokenHash).toBe("rt2");

    // Revoke client c2
    await reloaded1.revokeClient("c2");

    // Reload store again
    const reloaded2 = new FileOAuthStore(tmpDir);
    const clients2 = await reloaded2.listClients();
    expect(clients2).toHaveLength(1);
    expect(clients2[0].clientId).toBe("c1");

    const rtList2 = await reloaded2.listRefreshTokens();
    expect(rtList2).toHaveLength(0);
  });
});
