import { describe, expect, it } from "vitest";
import { assessSourceIdentity } from "../../src/utils/source-identity.js";

describe("assessSourceIdentity", () => {
  it("flags Hermes filename with Superpowers source and body as conflict", () => {
    const result = assessSourceIdentity({
      rawPath: "raw/articles/hermes-llm-wiki-SKILL-v2.1.0.md",
      sourceUrl: "https://raw.githubusercontent.com/obra/superpowers/main/README.md",
      body: "# Superpowers\n\nSuperpowers is a complete software development methodology for your coding agents.",
    });

    expect(result.status).toBe("conflict");
    expect(result.pathSignals).toContain("hermes");
    expect(result.pathSignals).toContain("skillwiki");
    expect(result.sourceSignals).toContain("superpowers");
    expect(result.bodySignals).toContain("superpowers");
    expect(result.reasons.join("\n")).toContain("filename/path signals");
  });

  it("allows the repaired Hermes llm-wiki source", () => {
    const result = assessSourceIdentity({
      rawPath: "raw/articles/hermes-llm-wiki-SKILL-v2.1.0.md",
      sourceUrl: "https://raw.githubusercontent.com/NousResearch/hermes-agent/main/skills/research/llm-wiki/SKILL.md",
      body: "# Karpathy's LLM Wiki\n\nBuild and maintain a persistent, compounding knowledge base.",
    });

    expect(result.status).toBe("ok");
    expect(result.pathSignals).toEqual(expect.arrayContaining(["hermes", "skillwiki"]));
    expect(result.sourceSignals).toContain("hermes");
    expect(result.bodySignals).toContain("skillwiki");
  });

  it("allows Superpowers filename with Superpowers source and body", () => {
    const result = assessSourceIdentity({
      rawPath: "raw/articles/superpowers-readme.md",
      sourceUrl: "https://raw.githubusercontent.com/obra/superpowers/main/README.md",
      body: "# Superpowers\n\nSuperpowers is a complete software development methodology for your coding agents.",
    });

    expect(result.status).toBe("ok");
    expect(result.pathSignals).toContain("superpowers");
    expect(result.sourceSignals).toContain("superpowers");
    expect(result.bodySignals).toContain("superpowers");
  });

  it("does not flag Proxmox helper pages for SeaweedFS as corruption", () => {
    const result = assessSourceIdentity({
      rawPath: "raw/articles/obsidian-import/Proxmox VE Helper Scripts.md",
      sourceUrl: "https://community-scripts.org/categories?category=files-and-downloads&preview=seaweedfs",
      body: '---\ntitle: "Proxmox VE Helper Scripts"\n---\n\n## SeaweedFS\n\nSeaweedFS is a fast distributed storage system.',
    });

    expect(result.status).toBe("ok");
    expect(result.pathSignals).toContain("proxmox");
    expect(result.sourceSignals).toContain("seaweedfs");
    expect(result.bodySignals).toContain("seaweedfs");
  });
});
