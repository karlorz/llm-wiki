# SkillWiki Onboarding Skill

This skill guides ChatGPT when interacting with the connected SkillWiki HTTP MCP server.

## Overview

SkillWiki is an operator-hosted knowledge base accessed exclusively via Model Context Protocol (MCP) tools.
Use the live `wiki_*` tools when available. If they are missing, hand connection setup to the operator outside this chat. Reviewers use the sample demo vault data provided by the operator.

## Installing the connection

Two operator paths reach the same MCP tools:

- **Workspace Create MCP plugin (ChatGPT web):** a person adds the custom MCP server in OpenAI Admin Console **Plugins** (xaicom may label it **Create MCP plugin**) with URL `https://wiki.karldigi.dev/mcp`, OAuth, and no custom headers. Identity is GitHub at `/workspace/authorize`, followed by one wiki grant: **Central Wiki** unless the operator names another wiki such as Finance Wiki. If the new plugin is Disabled or Unavailable, the operator reviews the app (tools and role access), acknowledges both risk prompts, publishes, then enables it. Installation policy alone does not connect member accounts.
- **App directory / trusted-host `/authorize`:** the operator configures the vault password for the existing trusted-host consent page.

## Connected MCP Tools

When connected to SkillWiki MCP, interact solely through the provided MCP tools:
- `wiki_context`: Check server connectivity, version, and vault configuration handshake.
- `wiki_query`: Search wiki notes and knowledge pages using semantic and keyword queries.
- `wiki_read_page`: Read markdown content of pages, schemas, and work items.
- `wiki_capture`: Capture ad-hoc notes, ideas, bugs, or tasks to the vault.
- `wiki_page_publish`: Publish or update typed knowledge pages under allowlisted layers (using Compare-And-Swap SHA-256).
- `wiki_workitem_write`: Update task or work-item tracking files.
- `wiki_log_append`: Append timestamped records to the vault log.

## Operating Principles

1. **Vault selection:** Omit `vault=` when invoking tools to use the connected default vault. Do not guess or specify other vault names unless the operator explicitly directs you to an authorized extra vault.
2. **Read before publish (CAS):** Before updating or publishing a page with `wiki_page_publish` or `wiki_workitem_write`, always read the page first with `wiki_read_page` to obtain its current `sha256`. Pass this as `base_sha256`.
3. **No local CLI or file writes:** Do not execute `skillwiki` CLI commands and do not attempt to write local files or run shell scripts. Everything is managed through the connected MCP server.
4. **No account creation:** Do not create accounts or send verification emails as part of this setup. Use the selected authentication path above.
5. **Stop when tools are missing:** If the `wiki_*` tools are not available in this chat, then nothing is connected. Say so and hand the setup to the operator. Do not try to create the plugin, complete OAuth, or enter a password from inside the chat.
