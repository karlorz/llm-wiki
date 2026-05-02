import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { runValidate } from "../../src/commands/validate.js";

const F = (n: string) => join(__dirname, "..", "fixtures", n);

describe("validate", () => {
  it("returns valid=true for a Hermes-shaped concept", async () => {
    const r = await runValidate({ file: F("valid-concept.md") });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      expect(r.result.data.valid).toBe(true);
      expect(r.result.data.schema).toBe("typed-knowledge");
    }
  });

  it("returns INVALID_FRONTMATTER with field errors", async () => {
    const r = await runValidate({ file: F("invalid-concept.md") });
    expect(r.exitCode).toBe(7);
    if (r.result.ok) {
      expect(r.result.data.valid).toBe(false);
      expect(r.result.data.errors.length).toBeGreaterThanOrEqual(2);
    }
  });

  it("returns SCHEMA_NOT_DETECTED for unknown shape", async () => {
    const r = await runValidate({ file: F("no-schema.md") });
    expect(r.exitCode).toBe(8);
  });

  it("returns FILE_NOT_FOUND for missing file", async () => {
    const r = await runValidate({ file: "/no/such/file" });
    expect(r.exitCode).toBe(2);
  });
});
