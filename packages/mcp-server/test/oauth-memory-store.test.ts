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
