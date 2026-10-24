# Connect an agent to a workspace wiki

Use one of the two requests below. Both use the same versioned, non-secret
[connection profile](workspace-connection.v1.json). This profile describes the
service contract; it is not a credential file or an input accepted by
`skillwiki connect`.

## Choose a workspace first

Workspace onboarding and agent connection are separate steps. An existing user
or a new user can use either connection route below once they belong to the
intended active workspace:

- **Existing workspace wiki:** sign in, accept an Owner's exact-identity
  invitation if needed, and select the intended workspace. Reuse a matching
  working agent connection or grant a separate one. Do not create another wiki
  to access the existing one.
- **New workspace wiki:** sign in and create a workspace only when your account
  has explicit creation permission. Wait for provisioning to finish; this
  creates an isolated wiki and makes you its Owner. Agent consent is a separate
  step afterward. When creation is unavailable, request operator permission or
  an invitation rather than bypassing the restriction.

Sign-in alone creates neither membership nor a wiki nor an MCP grant. A local
Obsidian vault is not automatically a registered workspace: importing/binding
existing storage is a separate operator migration. Neither setup request below
authorizes creating a workspace, migrating content or uploading a local vault.
If the intended workspace is unclear, ask before proceeding.

An explicit service URL takes precedence. Otherwise retain the saved connection
and its workspace; a new setup defaults to `https://wiki.karldigi.dev/mcp`.
Changing a service or workspace requires separate consent and separate private
credentials. Never silently retarget, fall back to another service or copy an
old token into a new connection.

## Connector request

```text
Connect this agent to my SkillWiki workspace using the Connector route in
https://github.com/karlorz/llm-wiki/blob/main/docs/workspace-onboarding.md
and its linked version-1 connection profile. Retain an existing matching
service/workspace connection unless I explicitly ask to replace it; otherwise
use the profile's default MCP URL unless I provide another compatible URL.
Use my selected existing or newly created workspace; ask if the target is
unclear. Do not create a workspace or import an existing vault automatically.
Use this host's native OAuth MCP connector, or its documented secure connector
framework if native MCP is unavailable. Verify live discovery, use public-client
registration and S256 PKCE, and let me complete GitHub sign-in and explicit
workspace consent. Request only the actions I need and offline_access only when
refresh is wanted. Keep credentials in the host's private credential store.
Verify the selected workspace identity and an own-wiki read, and report any
unsupported step. Do not grant access to another workspace or modify existing
connectors as a fallback. Wiki content remains in Obsidian.
```

Choose by actual host capabilities. Some hosts support remote OAuth MCP
directly. Others require their official typed credential request, secure vault
and a connector helper with its own tool instructions. The successful Muse
acceptance used that latter route; it did not install a native MCP connector.
Do not invent a privileged token-export tool or transfer credentials from another
host. If neither route is supported, report that limit and use the terminal
route only when a suitable terminal environment exists.

GitHub sign-in establishes identity. Workspace membership determines available
wikis, and the subsequent consent grants one connection access to one wiki.
Changing the console's selected workspace does not change an existing grant.

## Skill + CLI request

```text
Connect this terminal agent to my SkillWiki workspace using the Skill + CLI
route in https://github.com/karlorz/llm-wiki/blob/main/docs/workspace-onboarding.md
and its linked version-1 connection profile. Retain a matching saved connection;
for a new connection use the default MCP URL unless I explicitly provide a
compatible alternate. Use my selected existing or newly created workspace; ask
if the target is unclear. Do not create a workspace or import a vault
automatically. Use an OAuth-capable terminal client or the repository's
workspace helper, not a shared legacy host token. Check the required runtime and
live discovery, let me complete GitHub sign-in and one-workspace consent, and
save a separate private profile for this service and workspace without printing
secrets. Request only needed actions. Verify workspace identity and an own-wiki
read. Do not run skillwiki init, replace a saved profile or change sync/Obsidian
storage. If the browser cannot reach this terminal's callback, stop and report
that limitation instead of attempting an unrelated login or endpoint fallback.
```

The repository provides a source-built workspace helper. From a reviewed
checkout, install its dependencies and build `@skillwiki/mcp-server` using the
[development instructions](../README.md#development). With Node 20 or newer,
the helper's actual commands are:

```sh
# Read-only plus offline refresh; use a new private profile path.
node packages/mcp-server/dist/workspace-client.js authorize \
  https://wiki.karldigi.dev/mcp /private/path/central-workspace.json

# After consent, verify identity and read the selected wiki.
node packages/mcp-server/dist/workspace-client.js call \
  /private/path/central-workspace.json wiki_status '{}'
node packages/mcp-server/dist/workspace-client.js call \
  /private/path/central-workspace.json wiki_read_page '{"path":"SCHEMA.md"}'

# Rotate through the saved service/workspace, when needed.
node packages/mcp-server/dist/workspace-client.js refresh \
  /private/path/central-workspace.json
```

Append `--write` to `authorize` only when write access is intended. The helper
requests `offline_access` and saves secrets privately; the path above is a
placeholder, not an existing file. Open the authorization URL in a browser on
the **same machine** as the terminal callback. A laptop browser cannot reach a
remote SSH host's loopback callback without a separately arranged supported
connection. A timeout is not successful authorization.

The helper refuses to replace an existing profile. Calls use its saved endpoint
and workspace, automatically refresh near expiry when possible, and fail on
binding/discovery changes. Ambiguous refresh failure is not automatically
replayed. This is a source-built helper, not a newly published
`skillwiki workspace` command. The existing npm `skillwiki connect --from-file`
continues to configure operator-issued legacy host credentials; it does not
perform workspace OAuth or convert old tokens. Installing skills alone neither
creates a grant nor establishes a connection.

## Discovery and acceptance

For a newly selected service, validate the profile's metadata paths against the
selected origin. The protected resource must exactly match the MCP URL, and the
authorization server must describe that service. The repository helper supports
HTTPS `/mcp` URLs and same-machine HTTP loopback development URLs, rejects
embedded credentials/query/fragment, requires same-origin workspace discovery,
and refuses credential-forwarding redirects. A host must report incompatible
discovery rather than guessing endpoints or silently using the default service.

Verify `wiki_status` reports a workspace identity and the intended wiki, then
read `SCHEMA.md` with S3 verification. Where write access was approved, use one
clearly marked harmless note and read it back. A designated foreign wiki must
be denied for read/query/write; a scoped registry may return `VAULT_UNKNOWN`
for a real wiki outside the grant. Record the actual tested operations rather
than treating a successful connect card as full acceptance.

Reuse of a vaulted credential is not proof of refresh-token rotation. The Muse
acceptance proved own read/write, real foreign-wiki denial and post-revocation
HTTP 401; forced-expiry/provider refresh rotation on Muse was not tested.
Separate terminal acceptance proved access/refresh rotation and rejection after
revocation. The service currently advertises no token revocation endpoint;
revoke through the workspace console rather than inventing one.

Existing trusted-host connections remain compatible under their existing
permissions. They are not automatically converted or revoked. A shared legacy
token may serve several clients, so replace and verify every dependent client
before retiring it. No migration-reminder or automatic-install feature is
implied by these requests. One sentence starts setup; interactive sign-in and
consent remain necessary.

For deployment, storage, membership and migration details, see
[workspace administration](../packages/mcp-server/WORKSPACES.md).
