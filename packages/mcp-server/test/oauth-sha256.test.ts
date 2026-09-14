import { describe, expect, it } from "vitest";
import { sha256Hex } from "../src/oauth.js";

describe("sha256Hex", () => {
  it("returns UTF-8 SHA-256 hex of a known string", () => {
    expect(sha256Hex("hello")).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
  });
});
