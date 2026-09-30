# SkillWiki Onboarding Skill

This skill guides ChatGPT when interacting with the connected SkillWiki HTTP MCP server.

## Overview

SkillWiki is an operator-hosted knowledge base accessed exclusively via Model Context Protocol (MCP) tools.
Authentication is handled via OAuth at login time using the SkillWiki operator password for the connected vault.
Reviewer credentials use sample demo vault data provided by the operator.

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
4. **No account creation:** SkillWiki does not create accounts, send verification emails, or use third-party OAuth providers. Login is authenticated against the operator-configured vault password.
