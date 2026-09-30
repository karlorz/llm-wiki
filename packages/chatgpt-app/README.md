# SkillWiki ChatGPT App Package

This directory contains the listing package specification and static assets for publishing SkillWiki on the ChatGPT App directory.

## Directory Structure

- `plugin.json`: OpenAI Agent Plugins manifest describing SkillWiki, interface metadata, capability claims, and review test cases.
- `mcp.json`: Streamable HTTP MCP configuration pointing to `https://wiki.karldigi.dev/mcp` without embedded bearer tokens.
- `skills/get-started/SKILL.md`: Onboarding skill instructing ChatGPT on tool usage and operating principles.
- `public/`: Static legal and support pages (`index.html`, `privacy.html`, `terms.html`, `support.html`) served by Caddy.
- `assets/`: Square PNG icons (`logo.png`, `composer-icon.png`) for app display.
- `demo-vault/`: Sample markdown vault (`SCHEMA.md`, `index.md`, `concepts/sample-launch.md`) used for reviewer test cases and demo deployment (`skillwiki-demo`).

## Packaging

To package the bundle for upload:

```bash
bash scripts/pack-chatgpt-app.sh
```

This creates a ZIP archive in `artifacts/chatgpt-app/skillwiki-chatgpt-app-<version>.zip`.

Note:
- The package ZIP bundles `plugin.json`, `mcp.json`, `skills/`, and `assets/`.
- `public/` is served directly by Caddy on sg01 and is excluded from the upload ZIP.
- `demo-vault/` is seeded on sg01 at `/opt/skillwiki-mcp/vault-skillwiki-demo` and is excluded from the upload ZIP.
- No bearer token (`SKILLWIKI_MCP_TOKEN`) is included in `mcp.json` or anywhere in the ZIP bundle.
- The 22 `wiki-*` skills are not bundled; tool access is strictly over MCP.

## Attended Operator Setup on sg01

1. **Caddy Static Routing:** Caddy serves `public/` files at `/`, `/privacy`, `/terms`, and `/support`.
2. **OpenAI Apps Challenge:** The operator creates `/.well-known/openai-apps-challenge` as a plain-text file containing the verification challenge token provided during app submission. Never commit challenge tokens to git.
3. **Reviewer Credentials:** The reviewer password hash is configured on sg01 under the OAuth state directory (e.g., `review-password.hash`).
4. **Demo Recording URL:** The placeholder in `plugin.json` (`https://wiki.karldigi.dev/support`) can be replaced with a live demo recording URL prior to final submission.
