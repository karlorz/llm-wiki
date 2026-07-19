import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runWorkValidate } from "../../src/commands/work-validate.js";

function vaultWith(workRel: string, files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "vault-wv-"));
  writeFileSync(join(dir, "SCHEMA.md"), "# Schema\n");
  const abs = join(dir, workRel);
  mkdirSync(abs, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(abs, name), body);
  }
  return dir;
}

describe("runWorkValidate", () => {
  it("passes a clean completed work item", async () => {
    const work = "projects/demo/work/2026-07-20-clean";
    const dir = vaultWith(work, {
      "spec.md": `---
title: clean
status: completed
kind: issue
---

# Clean
`,
      "plan.md": `---
status: completed
---

# Plan

- [x] done
`,
      "evidence.md": `---
status: completed
---

# Evidence
`,
      "decisions.md": `## Decisions

- **Decision**: ship it
`,
    });
    const r = await runWorkValidate({ vault: dir, workItem: work, requireComplete: true });
    expect(r.exitCode).toBe(0);
    expect(r.result).toMatchObject({ ok: true, data: { valid: true, evidence_present: true } });
  });

  it("fails on missing evidence when requireComplete", async () => {
    const work = "projects/demo/work/2026-07-20-no-ev";
    const dir = vaultWith(work, {
      "spec.md": `---
title: x
status: completed
---

# X
`,
      "plan.md": `# Plan

- [x] a
`,
    });
    const r = await runWorkValidate({ vault: dir, workItem: work, requireComplete: true });
    expect(r.exitCode).toBe(13);
    if (r.result.ok) {
      expect(r.result.data.valid).toBe(false);
      expect(r.result.data.findings.some((f) => f.code === "missing_evidence")).toBe(true);
    }
  });

  it("fails on unchecked completion steps", async () => {
    const work = "projects/demo/work/2026-07-20-unchecked";
    const dir = vaultWith(work, {
      "spec.md": `---
status: completed
---

# S
`,
      "plan.md": `# Plan

- [ ] still open
`,
      "evidence.md": "# e\n",
    });
    const r = await runWorkValidate({ vault: dir, workItem: work, requireComplete: true });
    expect(r.exitCode).toBe(13);
    if (r.result.ok) {
      expect(r.result.data.findings.some((f) => f.code === "unchecked_steps")).toBe(true);
    }
  });

  it("fails on conflict markers", async () => {
    const work = "projects/demo/work/2026-07-20-conflict";
    const dir = vaultWith(work, {
      "spec.md": `---
status: in-progress
---

<<<<<<< HEAD
mine
=======
theirs
>>>>>>> branch
`,
    });
    const r = await runWorkValidate({ vault: dir, workItem: work });
    expect(r.exitCode).toBe(13);
    if (r.result.ok) {
      expect(r.result.data.findings.some((f) => f.code === "conflict_markers")).toBe(true);
      expect(r.result.data.conflict_markers).toBeGreaterThan(0);
    }
  });

  it("fails on bad PR metadata", async () => {
    const work = "projects/demo/work/2026-07-20-pr";
    const dir = vaultWith(work, {
      "spec.md": `---
status: completed
pr_url: not-a-url
pr_number: abc
merged: true
---

# S
`,
      "evidence.md": "# e\n",
    });
    const r = await runWorkValidate({ vault: dir, workItem: work, requireComplete: true });
    expect(r.exitCode).toBe(13);
    if (r.result.ok) {
      expect(r.result.data.findings.some((f) => f.code === "bad_pr_metadata")).toBe(true);
    }
  });
});
