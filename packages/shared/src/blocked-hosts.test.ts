import { describe, it, expect } from "vitest";
import { isBlockedHost, METADATA_HOSTS } from "./blocked-hosts.js";

describe("blocked-hosts", () => {
  it.each([
    "10.0.0.1", "10.255.255.255",
    "172.16.0.1", "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254",
    "127.0.0.1",
    "::1",
    "fe80::1"
  ])("blocks %s", (host) => {
    expect(isBlockedHost(host)).toBe(true);
  });

  it.each(["8.8.8.8", "1.1.1.1", "example.com"])("allows %s", (host) => {
    expect(isBlockedHost(host)).toBe(false);
  });

  it("has metadata hostnames", () => {
    expect(METADATA_HOSTS).toContain("metadata.google.internal");
  });

  it("172.32.0.1 is NOT in the blocked /12 range", () => {
    expect(isBlockedHost("172.32.0.1")).toBe(false);
  });
});
