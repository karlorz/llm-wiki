import { describe, expect, it } from "vitest";
import { hashPassword } from "../src/oauth.js";

describe("hashPassword", () => {
  it("encoded hash starts with scrypt$16384$8$1$ and contains $urlsafe$", () => {
    const encoded = hashPassword("operator-secret");
    expect(encoded.startsWith("scrypt$16384$8$1$")).toBe(true);
    expect(encoded).toContain("$urlsafe$");
  });
});
