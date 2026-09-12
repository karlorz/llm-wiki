import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  parseTokenMap,
  resolveHostId,
  sha256Token,
  unauthorizedHeaders,
} from "../src/auth.js";

describe("token resolution", () => {
  it("maps a bearer token to host_id via sha256 hex keys", () => {
    const token = "macos-dev-secret-token";
    const hash = createHash("sha256").update(token, "utf8").digest("hex");
    const map = parseTokenMap(`${hash}: macos-dev\n`);
    expect(resolveHostId(token, map)).toBe("macos-dev");
  });

  it("rejects a token whose hash is not in the map", () => {
    const map = parseTokenMap("deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef: other\n");
    expect(resolveHostId("wrong-token", map)).toBeUndefined();
  });

  it("does not confuse two tokens that share a prefix", () => {
    const a = "token-alpha";
    const b = "token-alpha-extra";
    const hashA = sha256Token(a).toString("hex");
    const hashB = sha256Token(b).toString("hex");
    const map = parseTokenMap(`${hashA}: host-a\n${hashB}: host-b\n`);
    expect(resolveHostId(a, map)).toBe("host-a");
    expect(resolveHostId(b, map)).toBe("host-b");
  });
});

describe("401 challenge", () => {
  it("sends WWW-Authenticate Bearer without a realm leak", () => {
    expect(unauthorizedHeaders()).toEqual({ "WWW-Authenticate": "Bearer" });
  });
});
