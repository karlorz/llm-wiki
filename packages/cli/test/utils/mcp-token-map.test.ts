import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { appendHostHash, generateHostBearer, parseMcpTokenMap } from "../../src/utils/mcp-token-map.js";

describe("mcp-token-map", () => {
  it("generateHostBearer hashes utf8 raw with sha256", () => {
    const rng = () => Buffer.alloc(32, 7);
    const { raw, hashHex } = generateHostBearer(rng);
    expect(raw).toBe(Buffer.alloc(32, 7).toString("base64url"));
    expect(hashHex).toBe(createHash("sha256").update(raw, "utf8").digest("hex"));
    expect(hashHex).toMatch(/^[0-9a-f]{64}$/);
  });

  it("appendHostHash appends hash to an existing map", () => {
    const existingHash = "a".repeat(64);
    const nextHash = "b".repeat(64);
    const result = appendHostHash(`${existingHash}: macos-dev\n`, nextHash, "sg03");
    expect("yaml" in result).toBe(true);
    if (!("yaml" in result)) return;
    const map = parseMcpTokenMap(result.yaml);
    expect(map.get(existingHash)).toBe("macos-dev");
    expect(map.get(nextHash)).toBe("sg03");
  });

  it("appendHostHash writes object principals for exact allowed_vaults", () => {
    const existingHash = "a".repeat(64);
    const nextHash = "b".repeat(64);
    const result = appendHostHash(`${existingHash}: macos-dev\n`, nextHash, "grok-bot-wiki-fin", ["wiki-fin"]);
    expect("yaml" in result).toBe(true);
    if (!("yaml" in result)) return;
    expect(result.yaml).toContain("writer_id: grok-bot-wiki-fin");
    expect(result.yaml).toContain("allowed_vaults: [wiki-fin]");
    const map = parseMcpTokenMap(result.yaml);
    expect(map.get(existingHash)).toBe("macos-dev");
    expect(map.get(nextHash)).toBe("grok-bot-wiki-fin");
  });

  it("appendHostHash refuses wildcards in allowed_vaults", () => {
    expect(appendHostHash("", "a".repeat(64), "grok-bot-wiki-fin", ["*"])).toEqual({
      error: "INVALID_ALLOWED_VAULTS",
    });
  });

  it("appendHostHash refuses duplicate host-id", () => {
    const h = "a".repeat(64);
    const result = appendHostHash(`${h}: macos-dev\n`, "b".repeat(64), "macos-dev");
    expect(result).toEqual({ error: "DUPLICATE_HOST_ID" });
  });

  it("appendHostHash refuses invalid host-id", () => {
    expect(appendHostHash("", "a".repeat(64), "SG03")).toEqual({ error: "INVALID_HOST_ID" });
  });
});
