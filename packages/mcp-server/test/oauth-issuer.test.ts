import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import { getIssuer } from "../src/oauth.js";

describe("getIssuer", () => {
  it("configured issuer wins and trailing slashes are stripped", () => {
    const req = { headers: { host: "ignored.example" } } as IncomingMessage;
    expect(getIssuer(req, "https://wiki.example.com/")).toBe("https://wiki.example.com");
    expect(getIssuer(req, "https://wiki.example.com///")).toBe("https://wiki.example.com");
  });
});
