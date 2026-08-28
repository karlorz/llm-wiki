import { describe, it, expect } from "vitest";
import { WorkItemSchema } from "./schemas.js";

const v = {
  title: "Fix race condition in worker",
  created: "2026-05-03",
  updated: "2026-05-03",
  started: "2026-05-03",
  kind: "issue",
  status: "in-progress",
  priority: "high",
  project: "[[cmux]]"
};

describe("WorkItemSchema", () => {
  it("accepts minimal valid", () => {
    expect(WorkItemSchema.parse(v)).toMatchObject(v);
  });

  it("requires `completed` when status is completed", () => {
    expect(() => WorkItemSchema.parse({ ...v, status: "completed" })).toThrow();
  });

  it("rejects unknown kind", () => {
    expect(() => WorkItemSchema.parse({ ...v, kind: "epic" })).toThrow();
  });

  it("rejects proposed status for non-executing queued findings", () => {
    expect(() => WorkItemSchema.parse({ ...v, status: "proposed" })).toThrow(
      /planned.*in-progress.*completed.*abandoned/
    );
  });

  it("accepts optional related/parent wikilinks", () => {
    expect(WorkItemSchema.parse({ ...v, parent: "[[2026-04-10-foo]]", related: ["[[2026-04-12-bar]]"] })).toBeTruthy();
  });

  it("accepts event-triggered opt-in post-release verification", () => {
    const completed = WorkItemSchema.parse({
      ...v,
      status: "completed",
      completed: "2026-05-04",
      post_release_verification: {
        posture: "opt-in",
        triggers: ["matching-regression-report", "explicit-user-request", "relevant-code-or-release-change"],
        last_proven: "2026-05-04",
        evidence: ["release tag v1.2.3", "production smoke passed"]
      }
    });

    expect(completed.post_release_verification).toEqual({
      posture: "opt-in",
      triggers: ["matching-regression-report", "explicit-user-request", "relevant-code-or-release-change"],
      last_proven: "2026-05-04",
      evidence: ["release tag v1.2.3", "production smoke passed"]
    });
  });

  it("rejects invalid post-release verification posture and triggers", () => {
    expect(() => WorkItemSchema.parse({
      ...v,
      post_release_verification: {
        posture: "always-ranked",
        triggers: ["nightly"]
      }
    })).toThrow();
  });

  it("rejects post-release verification before delivery is completed", () => {
    expect(() => WorkItemSchema.parse({
      ...v,
      post_release_verification: {
        posture: "opt-in",
        triggers: ["explicit-user-request"]
      }
    })).toThrow(/completed/);
  });
});
