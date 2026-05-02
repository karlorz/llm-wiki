import { describe, it, expect } from "vitest";
import { runFetchGuard } from "../../src/commands/fetch-guard.js";

describe("fetch-guard — Layer 1", () => {
  it("allows a plain https URL", async () => {
    const r = await runFetchGuard({ url: "https://example.com/x" });
    expect(r.exitCode).toBe(0);
    expect(r.result.ok).toBe(true);
    if (r.result.ok) {
      expect(r.result.data.allowed).toBe(true);
      expect(r.result.data.sanitized_url).toBe("https://example.com/x");
    }
  });

  it("rejects http (SCHEME_REJECTED)", async () => {
    const r = await runFetchGuard({ url: "http://example.com/x" });
    expect(r.exitCode).toBe(4);
  });

  it("rejects file:// (SCHEME_REJECTED)", async () => {
    const r = await runFetchGuard({ url: "file:///etc/passwd" });
    expect(r.exitCode).toBe(4);
  });

  it("rejects RFC 1918 hosts (HOST_BLOCKED)", async () => {
    const r = await runFetchGuard({ url: "https://10.0.0.1/x" });
    expect(r.exitCode).toBe(5);
  });

  it("rejects metadata endpoint (HOST_BLOCKED)", async () => {
    const r = await runFetchGuard({ url: "https://169.254.169.254/latest/meta-data/" });
    expect(r.exitCode).toBe(5);
  });

  it("rejects malformed URL (MALFORMED_URL)", async () => {
    const r = await runFetchGuard({ url: "not a url" });
    expect(r.exitCode).toBe(6);
  });

  it("strips api_key query param in sanitized_url", async () => {
    const r = await runFetchGuard({ url: "https://example.com/x?api_key=SECRET&q=hi" });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      expect(r.result.data.sanitized_url).not.toContain("SECRET");
      expect(r.result.data.sanitized_url).toContain("api_key=REDACTED");
      expect(r.result.data.sanitized_url).toContain("q=hi");
    }
  });

  it("strips path-embedded tokens (32+ hex chars)", async () => {
    const long = "deadbeef".repeat(8);
    const r = await runFetchGuard({ url: `https://example.com/api/${long}/resource` });
    if (r.result.ok) expect(r.result.data.sanitized_url).not.toContain(long);
  });

  it("strips userinfo (user:pass@)", async () => {
    const r = await runFetchGuard({ url: "https://user:pw@example.com/x" });
    if (r.result.ok) expect(r.result.data.sanitized_url).not.toContain("pw");
  });
});
