import { describe, expect, it } from "vitest";
import { InMemoryOAuthStore } from "../src/oauth-store.js";

describe("InMemoryOAuthStore.consumeAuthCode", () => {
  it("missing and expired codes return null", async () => {
    const store = new InMemoryOAuthStore();
    expect(await store.consumeAuthCode("missing-hash")).toBeNull();

    await store.saveAuthCode({
      codeHash: "expired-hash",
      clientId: "c1",
      redirectUri: "http://localhost/cb",
      codeChallenge: "challenge",
      codeChallengeMethod: "S256",
      writerId: "writer-test",
      expiresAt: Date.now() - 1,
    });
    expect(await store.consumeAuthCode("expired-hash")).toBeNull();
  });
});

describe("InMemoryOAuthStore.getAccessToken", () => {
  it("missing and expired tokens return null", async () => {
    const store = new InMemoryOAuthStore();
    expect(await store.getAccessToken("missing-hash")).toBeNull();

    await store.saveAccessToken({
      tokenHash: "expired-hash",
      clientId: "c1",
      writerId: "writer-test",
      expiresAt: Date.now() - 1,
    });
    expect(await store.getAccessToken("expired-hash")).toBeNull();
  });
});

describe("InMemoryOAuthStore grant management", () => {
  it("listClients returns saved clients", async () => {
    const store = new InMemoryOAuthStore();
    expect(await store.listClients()).toEqual([]);

    await store.saveClient({ clientId: "c1", redirectUris: ["https://a.com/cb"] });
    await store.saveClient({ clientId: "c2", redirectUris: ["https://b.com/cb"] });

    const clients = await store.listClients();
    expect(clients).toHaveLength(2);
    expect(clients.map((c) => c.clientId).sort()).toEqual(["c1", "c2"]);
  });

  it("listRefreshTokens drops expired entries and keeps active ones", async () => {
    const store = new InMemoryOAuthStore();
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
    const store = new InMemoryOAuthStore();
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
    const store = new InMemoryOAuthStore();
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

    // Check c2 is completely untouched
    expect(await store.getClient("c2")).not.toBeNull();
    expect(await store.consumeAuthCode("code-c2")).not.toBeNull();
    expect(await store.getAccessToken("at-c2")).not.toBeNull();

    const remainingRefresh = await store.listRefreshTokens();
    expect(remainingRefresh).toHaveLength(1);
    expect(remainingRefresh[0].tokenHash).toBe("rt-c2");
  });
});
