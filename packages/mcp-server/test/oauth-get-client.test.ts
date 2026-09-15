import { describe, expect, it } from "vitest";
import { InMemoryOAuthStore } from "../src/oauth-store.js";

describe("InMemoryOAuthStore.getClient", () => {
  it("unknown clientId returns null", async () => {
    const store = new InMemoryOAuthStore();
    expect(await store.getClient("unknown-client")).toBeNull();
  });
});
