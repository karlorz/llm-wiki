import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export function registerMcpPrompts(server: McpServer): void {
  server.registerPrompt(
    "skillwiki-research-query",
    {
      description: "Structured vault research using skillwiki.query and typed pages",
      argsSchema: {
        topic: z.string().describe("Research topic or question"),
      },
    },
    ({ topic }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: [
              "Research this topic against the skillwiki vault:",
              topic,
              "",
              "Steps:",
              "1. Call skillwiki.query with the topic (and vault if not default).",
              "2. Read skillwiki://vault/index for catalog context if needed.",
              "3. Synthesize an answer with page paths and citation markers ^[path].",
              "4. Note gaps and suggest follow-up queries.",
              "",
              "Do not mutate the vault. Use read-only MCP tools only.",
            ].join("\n"),
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "skillwiki-project-work-item",
    {
      description: "Plan a project work item using vault project workspace conventions",
      argsSchema: {
        slug: z.string().describe("Project slug"),
        idea: z.string().describe("Work item idea or bug/feature summary"),
      },
    },
    ({ slug, idea }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: [
              `Project: ${slug}`,
              `Idea: ${idea}`,
              "",
              "Use skillwiki.project_index and skillwiki://project/{slug}/index for context.",
              "Draft a work item outline: spec sections, acceptance criteria, risks.",
              "Follow vault paths under projects/{slug}/work/YYYY-MM-DD-{slug}/.",
              "Do not write files via MCP in MVP; output markdown for human or proj-work skill.",
            ].join("\n"),
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "skillwiki-vault-health-review",
    {
      description: "Review vault health via lint summary, doctor, and stale tools",
      argsSchema: {
        vault: z.string().optional().describe("Optional vault path"),
      },
    },
    ({ vault }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: [
              vault ? `Vault: ${vault}` : "Vault: default resolved path",
              "",
              "Run skillwiki.lint_summary, skillwiki.doctor, and skillwiki.stale.",
              "Prioritize errors over warnings; list top 5 actionable fixes.",
              "Reference existing wiki-lint / wiki-sync skills for remediation.",
            ].join("\n"),
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "skillwiki-citation-audit",
    {
      description: "Audit citation health using query + lint buckets",
      argsSchema: {
        focus: z.string().optional().describe("Page or topic focus"),
      },
    },
    ({ focus }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: [
              focus ? `Focus: ${focus}` : "Focus: whole vault",
              "",
              "Call skillwiki.lint_summary with only=orphaned_citations or wikilink_citation if needed.",
              "Cross-check with skillwiki.query on related terms.",
              "Report pages with broken or legacy citation markers and suggested fixes.",
            ].join("\n"),
          },
        },
      ],
    }),
  );
}