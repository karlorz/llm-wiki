import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  appendHostHash as cliAppendHostHash,
  generateHostBearer as cliGenerateHostBearer,
} from "../../cli/src/utils/mcp-token-map.js";
import { HOST_ID_RE, appendHostHash, generateHostBearer, parseMcpTokenMap, parseMcpTokenPrincipals, removeHostId } from "../src/token-map.js";

describe("token-map helpers", () => {
  it("generateHostBearer returns base64url raw and matching sha256", () => {
    const fixed = () => Buffer.alloc(32, 7);
    const generated = generateHostBearer(fixed);
    expect(generated.raw).toBe(Buffer.alloc(32, 7).toString("base64url"));
    expect(generated.hashHex).toBe(createHash("sha256").update(generated.raw, "utf8").digest("hex"));
    expect(generated.hashHex).toMatch(/^[0-9a-f]{64}$/);
  });

  it("appendHostHash rejects invalid, duplicate host-id, and duplicate hash", () => {
    const hashA = "a".repeat(64);
    const hashB = "b".repeat(64);
    const seed = `${hashA}: macos-dev\n`;
    expect(appendHostHash(seed, hashB, "SG01")).toEqual({ error: "INVALID_HOST_ID" });
    expect(HOST_ID_RE.test("SG01")).toBe(false);
    expect(appendHostHash(seed, hashB, "macos-dev")).toEqual({ error: "DUPLICATE_HOST_ID" });
    expect(appendHostHash(seed, hashA, "sg01")).toEqual({ error: "DUPLICATE_HASH" });
    const ok = appendHostHash(seed, hashB, "sg01");
    expect(ok).toEqual({ yaml: `${hashA}: macos-dev\n${hashB}: sg01\n` });
    expect(parseMcpTokenMap("yaml" in ok ? ok.yaml : "").get(hashB)).toBe("sg01");
  });

  it("removeHostId drops the matching line and reports missing", () => {
    const hashA = "a".repeat(64);
    const hashB = "b".repeat(64);
    const seed = `${hashA}: macos-dev\n${hashB}: sg01\n`;
    expect(removeHostId(seed, "missing")).toEqual({ error: "NOT_FOUND" });
    expect(removeHostId(seed, "sg01")).toEqual({ yaml: `${hashA}: macos-dev\n` });
    expect(removeHostId(`${hashA}: macos-dev\n`, "macos-dev")).toEqual({ yaml: "" });
  });

  it("parses object principals with allowed_vaults and keeps string host-id rows", () => {
    const hashA = "a".repeat(64);
    const hashB = "b".repeat(64);
    const yaml = `${hashA}: macos-dev\n${hashB}:\n  writer_id: sg01\n  allowed_vaults: [central, wiki-fin]\n`;
    const map = parseMcpTokenMap(yaml);
    expect(map.get(hashA)).toBe("macos-dev");
    expect(map.get(hashB)).toBe("sg01");
    const principals = parseMcpTokenPrincipals(yaml);
    expect(principals.get(hashB)).toEqual({ writerId: "sg01", allowedVaults: ["central", "wiki-fin"] });
    expect(principals.get(hashA)).toEqual({ writerId: "macos-dev" });
  });

  it("matches CLI mcp-token-map generate and append results", () => {
    const rng = () => Buffer.alloc(32, 3);
    expect(generateHostBearer(rng)).toEqual(cliGenerateHostBearer(rng));
    const seed = `${"c".repeat(64)}: macos-dev\n`;
    const next = "d".repeat(64);
    expect(appendHostHash(seed, next, "sg03")).toEqual(cliAppendHostHash(seed, next, "sg03"));
    expect(appendHostHash(seed, next, "macos-dev")).toEqual(cliAppendHostHash(seed, next, "macos-dev"));
  });
});
