import { describe, expect, it } from "vitest";
import { verifyPassword } from "../src/oauth.js";

describe("verifyPassword", () => {
  it("malformed encoded hash (wrong part count or prefix) is false", () => {
    expect(verifyPassword("secret", "not-enough-parts")).toBe(false);
    expect(verifyPassword("secret", "pbkdf2$16384$8$1$salt$urlsafe$hash")).toBe(false);
  });
});
