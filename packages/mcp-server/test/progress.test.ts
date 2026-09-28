import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { AddressInfo } from "node:net";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ReconcileGate } from "../src/reconcile.js";
import { startMcpHttpServer } from "../src/server.js";
import { makeTempVault } from "./helpers.js";

async function setupTestServer(options?: { gateReady?: boolean }) {
  const vault = await makeTempVault();
  const token = "test-token";
  const hash = createHash("sha256").update(token, "utf8").digest("hex");
  const gate = new ReconcileGate(async () => undefined);
  if (options?.gateReady !== false) {
    await gate.runFirst();
  }
  const server = await startMcpHttpServer({
    bind: "127.0.0.1",
    port: 0,
    vaultDir: vault,
    tokenMap: new Map([[hash, "macos-dev"]]),
    gate,
    putObject: async () => undefined,
  });
  const { port } = server.address() as AddressInfo;
  return {
    vault,
    token,
    port,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

async function callProgress(
  port: number,
  token: string,
  args: Record<string, unknown> = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "wiki_progress",
        arguments: args,
      },
    }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("wiki_progress tool", () => {
  it("scans projects/*/work/*/spec.md, extracts fields, and sorts recent_progress, todos, and key_projects", async () => {
    const ctx = await setupTestServer();
    try {
      // Create project alpha with 3 items
      await mkdir(join(ctx.vault, "projects/alpha/work/2026-09-01-item-a"), { recursive: true });
      await writeFile(
        join(ctx.vault, "projects/alpha/work/2026-09-01-item-a/spec.md"),
        `---
title: Item Alpha 1
status: in-progress
priority: medium
created: 2026-08-30
updated: 2026-09-01
host: macos-dev
agent_role: architect
agent_id: arch-1
---
Alpha 1 spec
`,
        "utf8",
      );

      await mkdir(join(ctx.vault, "projects/alpha/work/2026-09-02-item-b"), { recursive: true });
      await writeFile(
        join(ctx.vault, "projects/alpha/work/2026-09-02-item-b/spec.md"),
        `---
title: Item Alpha 2
status: planned
priority: high
created: 2026-09-02
host: macos-dev
agent_role: reviewer
agent_id: rev-1
---
Alpha 2 spec
`,
        "utf8",
      );

      // Create project beta with 1 item without priority or title (fallback to work_item)
      await mkdir(join(ctx.vault, "projects/beta/work/2026-09-03-item-c"), { recursive: true });
      await writeFile(
        join(ctx.vault, "projects/beta/work/2026-09-03-item-c/spec.md"),
        `---
status: in-progress
created: 2026-09-03
host: remote-worker
agent_role: coder
---
Beta item C
`,
        "utf8",
      );

      const { status, body } = await callProgress(ctx.port, ctx.token);
      expect(status).toBe(200);
      const res = body.result as {
        structuredContent?: {
          ok: boolean;
          recent_progress: Array<Record<string, unknown>>;
          todos: Array<Record<string, unknown>>;
          key_projects: Array<Record<string, unknown>>;
        };
      };
      const data = res.structuredContent;
      expect(data?.ok).toBe(true);

      // Verify entries
      expect(data?.recent_progress).toHaveLength(3);
      // Recent sort: date descending then work_item descending
      // 2026-09-03 (item-c), 2026-09-02 (item-b), 2026-09-01 (item-a)
      expect(data?.recent_progress[0].work_item).toBe("2026-09-03-item-c");
      expect(data?.recent_progress[0].title).toBe("2026-09-03-item-c"); // fallback
      expect(data?.recent_progress[0].project).toBe("beta");
      expect(data?.recent_progress[0].date).toBe("2026-09-03");

      expect(data?.recent_progress[1].work_item).toBe("2026-09-02-item-b");
      expect(data?.recent_progress[1].title).toBe("Item Alpha 2");
      expect(data?.recent_progress[1].priority).toBe("high");

      expect(data?.recent_progress[2].work_item).toBe("2026-09-01-item-a");
      expect(data?.recent_progress[2].title).toBe("Item Alpha 1");
      expect(data?.recent_progress[2].priority).toBe("medium");
      expect(data?.recent_progress[2].host).toBe("macos-dev");
      expect(data?.recent_progress[2].agent_role).toBe("architect");
      expect(data?.recent_progress[2].agent_id).toBe("arch-1");
      expect(data?.recent_progress[2].path).toBe("projects/alpha/work/2026-09-01-item-a/spec.md");

      // Todos sort: priority (high -> medium -> low -> undefined), then date descending, then work_item descending
      expect(data?.todos).toHaveLength(3);
      expect(data?.todos[0].work_item).toBe("2026-09-02-item-b"); // high
      expect(data?.todos[1].work_item).toBe("2026-09-01-item-a"); // medium
      expect(data?.todos[2].work_item).toBe("2026-09-03-item-c"); // no priority

      // Key projects aggregation:
      // alpha: active_count=2, highest_priority=high, newest_date=2026-09-02, work_items=["2026-09-02-item-b", "2026-09-01-item-a"]
      // beta: active_count=1, highest_priority=undefined, newest_date=2026-09-03, work_items=["2026-09-03-item-c"]
      // sorted by active_count desc
      expect(data?.key_projects).toHaveLength(2);
      expect(data?.key_projects[0].project).toBe("alpha");
      expect(data?.key_projects[0].active_count).toBe(2);
      expect(data?.key_projects[0].highest_priority).toBe("high");
      expect(data?.key_projects[0].newest_date).toBe("2026-09-02");
      expect(data?.key_projects[0].work_items).toEqual(["2026-09-02-item-b", "2026-09-01-item-a"]);

      expect(data?.key_projects[1].project).toBe("beta");
      expect(data?.key_projects[1].active_count).toBe(1);
      expect(data?.key_projects[1].newest_date).toBe("2026-09-03");
    } finally {
      await ctx.close();
    }
  });

  it("skips malformed specs, unclosed frontmatter, and specs outside planned/in-progress", async () => {
    const ctx = await setupTestServer();
    try {
      await mkdir(join(ctx.vault, "projects/alpha/work/2026-09-01-completed"), { recursive: true });
      await writeFile(
        join(ctx.vault, "projects/alpha/work/2026-09-01-completed/spec.md"),
        `---
title: Done item
status: completed
priority: high
---
Done
`,
        "utf8",
      );

      await mkdir(join(ctx.vault, "projects/alpha/work/2026-09-02-abandoned"), { recursive: true });
      await writeFile(
        join(ctx.vault, "projects/alpha/work/2026-09-02-abandoned/spec.md"),
        `---
title: Abandoned item
status: abandoned
priority: high
---
Abandoned
`,
        "utf8",
      );

      await mkdir(join(ctx.vault, "projects/alpha/work/2026-09-03-bad-yaml"), { recursive: true });
      await writeFile(
        join(ctx.vault, "projects/alpha/work/2026-09-03-bad-yaml/spec.md"),
        `---
title: Bad
status: [planned
---
Bad yaml
`,
        "utf8",
      );

      await mkdir(join(ctx.vault, "projects/alpha/work/2026-09-04-unclosed"), { recursive: true });
      await writeFile(
        join(ctx.vault, "projects/alpha/work/2026-09-04-unclosed/spec.md"),
        `---
title: Unclosed
status: planned
`,
        "utf8",
      );

      await mkdir(join(ctx.vault, "projects/alpha/work/2026-09-05-no-spec"), { recursive: true });

      await mkdir(join(ctx.vault, "projects/alpha/work/2026-09-06-valid"), { recursive: true });
      await writeFile(
        join(ctx.vault, "projects/alpha/work/2026-09-06-valid/spec.md"),
        `---
title: Only Valid
status: planned
priority: low
---
Valid
`,
        "utf8",
      );

      await mkdir(join(ctx.vault, "projects/alpha/work/2026-09-07-invalid-identity"), { recursive: true });
      await writeFile(
        join(ctx.vault, "projects/alpha/work/2026-09-07-invalid-identity/spec.md"),
        `---
title: Invalid Identity
status: planned
host: "bad host"
---
Invalid
`,
        "utf8",
      );

      const { body } = await callProgress(ctx.port, ctx.token);
      const res = body.result as {
        structuredContent?: {
          recent_progress: Array<Record<string, unknown>>;
          key_projects: Array<Record<string, unknown>>;
        };
      };
      expect(res.structuredContent?.recent_progress).toHaveLength(1);
      expect(res.structuredContent?.recent_progress[0].work_item).toBe("2026-09-06-valid");
      expect(res.structuredContent?.key_projects).toHaveLength(1);
      expect(res.structuredContent?.key_projects[0].active_count).toBe(1);
    } finally {
      await ctx.close();
    }
  });

  it("filters by project, host, and agent_role with exact match", async () => {
    const ctx = await setupTestServer();
    try {
      await mkdir(join(ctx.vault, "projects/alpha/work/2026-09-01-item1"), { recursive: true });
      await writeFile(
        join(ctx.vault, "projects/alpha/work/2026-09-01-item1/spec.md"),
        `---
title: Alpha Item 1
status: planned
host: host-1
agent_role: builder
---
`,
        "utf8",
      );

      await mkdir(join(ctx.vault, "projects/alpha/work/2026-09-02-item2"), { recursive: true });
      await writeFile(
        join(ctx.vault, "projects/alpha/work/2026-09-02-item2/spec.md"),
        `---
title: Alpha Item 2
status: in-progress
host: host-2
agent_role: reviewer
---
`,
        "utf8",
      );

      await mkdir(join(ctx.vault, "projects/beta/work/2026-09-03-item3"), { recursive: true });
      await writeFile(
        join(ctx.vault, "projects/beta/work/2026-09-03-item3/spec.md"),
        `---
title: Beta Item 3
status: planned
host: host-1
agent_role: builder
---
`,
        "utf8",
      );

      // Filter by project=alpha
      const pRes = await callProgress(ctx.port, ctx.token, { project: "alpha" });
      const pData = (pRes.body.result as any).structuredContent;
      expect(pData.recent_progress).toHaveLength(2);
      expect(pData.key_projects).toHaveLength(1);
      expect(pData.key_projects[0].project).toBe("alpha");

      // Filter by host=host-1
      const hRes = await callProgress(ctx.port, ctx.token, { host: "host-1" });
      const hData = (hRes.body.result as any).structuredContent;
      expect(hData.recent_progress).toHaveLength(2);
      expect(hData.recent_progress.map((e: any) => e.work_item)).toEqual(["2026-09-03-item3", "2026-09-01-item1"]);

      // Filter by agent_role=reviewer
      const rRes = await callProgress(ctx.port, ctx.token, { agent_role: "reviewer" });
      const rData = (rRes.body.result as any).structuredContent;
      expect(rData.recent_progress).toHaveLength(1);
      expect(rData.recent_progress[0].work_item).toBe("2026-09-02-item2");

      // Filter by combination matching 0 items
      const noneRes = await callProgress(ctx.port, ctx.token, { host: "host-2", agent_role: "builder" });
      const noneData = (noneRes.body.result as any).structuredContent;
      expect(noneData.recent_progress).toHaveLength(0);
      expect(noneData.key_projects).toHaveLength(0);
      expect(noneData.todos).toHaveLength(0);
    } finally {
      await ctx.close();
    }
  });

  it("handles unknown project and invalid identities fail closed", async () => {
    const ctx = await setupTestServer();
    try {
      // Unknown project
      const unk = await callProgress(ctx.port, ctx.token, { project: "does-not-exist" });
      expect((unk.body.result as any).structuredContent).toEqual({
        ok: false,
        error: "USAGE",
        message: "unknown project",
      });

      // Malformed project slug
      const malProj = await callProgress(ctx.port, ctx.token, { project: "bad/slug" });
      expect((malProj.body.result as any).structuredContent).toEqual({
        ok: false,
        error: "USAGE",
        message: "project must be a vault project slug",
      });

      // Invalid host token
      const badHost = await callProgress(ctx.port, ctx.token, { host: "bad host with spaces" });
      expect((badHost.body.result as any).structuredContent.ok).toBe(false);
      expect((badHost.body.result as any).structuredContent.error).toBe("USAGE");
      expect((badHost.body.result as any).structuredContent.message).toContain("invalid host");

      // Invalid agent_role token
      const badRole = await callProgress(ctx.port, ctx.token, { agent_role: "bad@role!" });
      expect((badRole.body.result as any).structuredContent.ok).toBe(false);
      expect((badRole.body.result as any).structuredContent.error).toBe("USAGE");
      expect((badRole.body.result as any).structuredContent.message).toContain("invalid agent_role");
    } finally {
      await ctx.close();
    }
  });

  it("enforces limit default 10 and max 50 capping top-level arrays", async () => {
    const ctx = await setupTestServer();
    try {
      // Generate 15 items in alpha
      for (let i = 1; i <= 15; i++) {
        const idx = String(i).padStart(2, "0");
        const dir = `2026-09-${idx}-task`;
        await mkdir(join(ctx.vault, `projects/alpha/work/${dir}`), { recursive: true });
        await writeFile(
          join(ctx.vault, `projects/alpha/work/${dir}/spec.md`),
          `---
title: Task ${i}
status: planned
created: 2026-09-${idx}
---
`,
          "utf8",
        );
      }

      // Default limit 10
      const defRes = await callProgress(ctx.port, ctx.token);
      const defData = (defRes.body.result as any).structuredContent;
      expect(defData.recent_progress).toHaveLength(10);
      expect(defData.todos).toHaveLength(10);
      expect(defData.key_projects[0].work_items).toHaveLength(5); // key_projects work_items capped at 5

      // Explicit limit 5
      const cap5Res = await callProgress(ctx.port, ctx.token, { limit: 5 });
      const cap5Data = (cap5Res.body.result as any).structuredContent;
      expect(cap5Data.recent_progress).toHaveLength(5);
      expect(cap5Data.todos).toHaveLength(5);

      // Values above the documented maximum fail validation.
      const largeRes = await callProgress(ctx.port, ctx.token, { limit: 100 });
      expect((largeRes.body.result as any).isError).toBe(true);
    } finally {
      await ctx.close();
    }
  });

  it("is strictly read-only and performs no filesystem writes", async () => {
    const ctx = await setupTestServer();
    try {
      await mkdir(join(ctx.vault, "projects/alpha/work/2026-09-01-item"), { recursive: true });
      const specContent = `---
title: Read Only Check
status: planned
created: 2026-09-01
---
Body
`;
      await writeFile(join(ctx.vault, "projects/alpha/work/2026-09-01-item/spec.md"), specContent, "utf8");

      const beforeLog = await readFile(join(ctx.vault, "log.md"), "utf8");
      await callProgress(ctx.port, ctx.token);

      const afterLog = await readFile(join(ctx.vault, "log.md"), "utf8");
      expect(afterLog).toBe(beforeLog);

      const afterSpec = await readFile(join(ctx.vault, "projects/alpha/work/2026-09-01-item/spec.md"), "utf8");
      expect(afterSpec).toBe(specContent);
    } finally {
      await ctx.close();
    }
  });
});
