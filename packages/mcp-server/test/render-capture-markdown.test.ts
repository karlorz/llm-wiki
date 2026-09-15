import { describe, expect, it } from "vitest";
import { renderCaptureMarkdown } from "../src/tools/writes.js";

describe("renderCaptureMarkdown", () => {
  it("when agent_note is omitted, the rendered capture has no agent_note: line", () => {
    const md = renderCaptureMarkdown({
      kind: "note",
      project: "llm-wiki",
      title: "omit agent note",
      content: "Body",
      date: "2026-09-15",
    });
    expect(md).not.toContain("agent_note:");
  });
});
