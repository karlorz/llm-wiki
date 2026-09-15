import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyPkce } from "../src/oauth.js";

describe("verifyPkce", () => {
  it("non-S256 method is false; matching S256 verifier/challenge is true", () => {
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const challenge = createHash("sha256").update(verifier, "ascii").digest("base64url");

    expect(verifyPkce(verifier, challenge, "plain")).toBe(false);
    expect(verifyPkce(verifier, challenge, "S256")).toBe(true);
  });
});
