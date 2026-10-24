# Workspace administration

The daemon supports an explicitly enabled workspace control plane with production
S3/rclone storage. The public administration surface is `/admin`; the older
operator `/console` remains loopback-only. Deployment and migration are separate
operator actions; startup never imports an existing wiki automatically.

The reviewed product specification and migration checklist remain in the central
wiki at `projects/llm-wiki/work/2026-10-24-workspace-wiki-console/`. Muse reviewed
the design at <https://muse.ai/thread/411d43f8-8092-45b9-86f2-b5e24da2e9c1>.

## Local console

Build from the repository root:

```sh
npm run -w @skillwiki/mcp-server build
```

Use a **dedicated development GitHub OAuth app** with callback
`http://127.0.0.1:8878/auth/github/callback`. Supply its client ID and secret through
`SKILLWIKI_WORKSPACE_DEV_GITHUB_CLIENT_ID` and
`SKILLWIKI_WORKSPACE_DEV_GITHUB_CLIENT_SECRET` in your private process environment.
Never copy production application secrets into this fixture. Numeric GitHub IDs
in `SKILLWIKI_WORKSPACE_DEV_CREATOR_IDS` (comma-separated) receive creation
allowance when they sign in; the default empty list permits no self-service
creation. No credential values are printed or stored in the wiki.

Choose explicit local grant/invitation lifetimes; these example values are test
policy, not product defaults:

```sh
node packages/mcp-server/dist/workspace-local.js \
  --directory /tmp/skillwiki-workspace-development \
  --port 8878 --grant-hours 24 --invitation-hours 24
```

The launcher binds `127.0.0.1` only and refuses an unrelated nonempty directory.
It never loads production MCP/S3 settings or host-id tokens. New wiki content is
stored under this development directory. GitHub identity responses are mocked
in automated tests; a real development-app sign-in is a separate manual check.

The web surface covers sign-in, workspace choice/creation, durable setup status,
members, invitations, connections, audit and settings. Content browsing and
search remain in Obsidian. Migration has no web page. Direct Obsidian/storage
credential distribution is an operator task and is not performed by sign-in.

## Authorization model

- Stable GitHub numeric identity; browser-bound one-use state and S256 PKCE.
  Provider tokens are used for identity lookup only and are never persisted.
- Sign-in creates no membership, wiki, storage access or MCP connection.
- Explicit account creation allowance, maximum one active owned workspace,
  server-generated workspace/vault IDs, one isolated namespace, required schema
  files only. Pending creation also reserves the allowance against concurrent
  requests. Activation rechecks eligibility.
- Persisted operation IDs and schema checkpoints. Retries reuse the same
  operation and IDs. Running native operations resume after a clean restart.
  Failed namespaces remain quarantined. Workspace and first Owner activation
  share one atomic control-state write.
- Invitations use lookup, owner confirmation of numeric ID, then exact-identity
  acceptance. The last Owner is protected.
- Every active member can consent to their own personal connection within their
  current role: Owner/Editor read and write, Viewer read only. Owners see/revoke
  all workspace connections; other members see/revoke only their own. There is
  no proxy consent or service-identity issuance in V1.
  Demotion permanently reduces actions; removal, suspension, archive and
  revocation invalidate future requests/refresh. Promotion never expands a grant.
- Separate one-workspace consent; exact registered callback; S256 PKCE, client,
  resource and scope checks. Missing content scopes default to read-only and are
  shown in consent. Refresh credentials are issued only for `offline_access`.
  Refresh rotation retains used hashes and revokes the grant on replay.
- V1 access tokens have a separate prefix and never enter legacy default-vault
  normalization. Every MCP tool call rechecks access/actions. SSE checks current
  authorization before events and pings. Workspace status does not inspect
  daemon-home fleet or projection settings.

The JSON control plane uses a single-writer process lock, strict schema loading,
private files, fsync and atomic rename. Corrupt state is never reset to empty.
After an unclean process exit, the lock deliberately fails closed: an operator
must stop competing processes, verify the recorded PID is dead on the recorded
host and recover the stale lock offline. Automatic stale-lock reclamation is
excluded because racing reclaimers could remove a new owner's lock. Existing
operation state is preserved for resumption. The control plane is single-process, not a distributed database. Production wiki
content uses the configured S3/rclone namespace; control state must be backed up
separately and must not be placed inside any wiki root.

Capacity and retention policy are unset. No destructive purge, automatic
break-glass, external Git provisioning or billing is implemented. New storage
roots cannot overlap the configured legacy roots; this does not revoke direct
Git/S3/FUSE/backup credentials or erase already downloaded Obsidian copies.

## Two connection routes

A native OAuth MCP connector uses the local `/mcp` URL and discovery; GitHub
sign-in is followed by separate workspace consent. Installed production
connectors and credentials remain untouched.

The terminal helper uses the same grant registry. It takes the selected endpoint
explicitly, validates discovery and saves a private profile without printing
credential values:

```sh
node packages/mcp-server/dist/workspace-client.js authorize \
  http://127.0.0.1:8878/mcp /tmp/my-workspace-profile.json
# Add --write only when write access is wanted.
node packages/mcp-server/dist/workspace-client.js call \
  /tmp/my-workspace-profile.json wiki_read_page '{"path":"index.md"}'
node packages/mcp-server/dist/workspace-client.js refresh /tmp/my-workspace-profile.json
```

Open the displayed authorization URL in a browser **on the same machine** as the
waiting terminal callback. A browser on another SSH client cannot complete that
loopback flow. Existing host-id credentials remain the supported legacy route.
The helper refuses to replace an existing profile during authorization. Refresh
uses the saved service/workspace and refuses discovery or binding changes; it
never falls back to a default service. Different services/workspaces use distinct
profile files. Ambiguous refresh/network failure may require fresh consent; the
helper does not replay a refresh automatically.

This helper is currently a local development entry point, not a published plugin
or an automatic installer. The existing `skillwiki connect` host-id contract is
unchanged. Generic one-sentence installation prompts should be finalized only
after actual host integration is verified.

## Production configuration

Enable only with complete explicit configuration. Missing or invalid required
settings fail startup; there is no fallback to local development storage.

```text
SKILLWIKI_WORKSPACE_ENABLED=true
SKILLWIKI_WORKSPACE_STATE_DIR=/opt/skillwiki-mcp/workspace-control
SKILLWIKI_WORKSPACE_LOCAL_ROOT=/opt/skillwiki-mcp/workspace-wikis
SKILLWIKI_WORKSPACE_S3_PREFIX=workspace-wikis
SKILLWIKI_WORKSPACE_GITHUB_CLIENT_ID=<dedicated SkillWiki app ID>
SKILLWIKI_WORKSPACE_GITHUB_CLIENT_SECRET_FILE=/etc/skillwiki-mcp/workspace-github.secret
SKILLWIKI_WORKSPACE_CREATOR_IDS=<explicit numeric GitHub IDs, or empty>
SKILLWIKI_WORKSPACE_GRANT_HOURS=<explicit positive hours>
SKILLWIKI_WORKSPACE_INVITATION_HOURS=<explicit positive hours>
```

Use a dedicated SkillWiki GitHub OAuth app, with callback
`https://<issuer-host>/auth/github/callback`; never reuse the GrokSearch secret.
Grant/invitation lifetimes have no hidden product defaults. Access tokens expire
within one hour or at grant expiry. An empty creator list permits invited users
to sign in without permitting new storage allocation. State and native wiki roots
must be separate, private, persistent and outside all existing wiki roots.

S3 endpoint, region, bucket, credentials and rclone remote come from the existing
daemon configuration. The reserved native prefix/root must not overlap any
legacy entry. New namespaces initialize only the required schema files with
conditional object creation; inherited content is quarantined. Reconciliation
and an actual write/read/delete probe must pass before activation. Each native
wiki gets its own cached runtime. Imported wikis reuse the exact existing runtime
and verify their stored binding hash; configuration drift fails closed.

Proxy only `/admin`, `/admin/*`, `/auth/github/*` and `/workspace/authorize` in
addition to existing MCP/OAuth routes. Preserve the existing legal pages,
reviewer-vault routes and private `/console` boundary. GitHub sign-in grants no
MCP access by itself. The consent page retains an explicit trusted-host password
route for existing operator/reviewer clients; that route never grants membership.

Workspace HTML uses `Referrer-Policy: same-origin`: native browser POST forms
must retain their exact issuer Origin for the origin and CSRF checks. Do not
override this with `no-referrer`, which makes Chromium submit `Origin: null`.
Cross-origin destinations still receive no referrer. For an existing 0.10.117
deployment awaiting the source fix, the workspace-only reverse proxy can apply
`header_down Referrer-Policy same-origin`; keep all origin/CSRF checks enabled.
All workspace forms retain self-only CSP `form-action`. Successful consent ends
the POST with a no-store confirmation page, then navigates to the exact validated
registered callback using an immediate meta refresh and a Continue link fallback.
This separates client navigation from the form submission: Chromium otherwise
applies `form-action` to every redirect hop, including a provider callback that
forwards to a second client origin. Do not add client-specific downstream domains,
wildcards or blanket HTTPS/loopback CSP allowances to work around that chain.

## Deployment-time command-line migration

Inventory every legacy wiki independently, including Central and Finance. The
JSON inventory is strict and secret-free: `version: 1`, `deploymentRevision`,
and `wikis`. Each wiki includes `vaultId`, `workspaceName`, `ownerGithubId`,
`ownerLogin`, optional `workspaceSlug`, exact `localRoot`, `rcloneRemote`,
`rclonePath`, `s3Bucket`, `s3Prefix`, optional `s3Endpoint`/`s3Region`,
`liveAccessVerified`, `fullInventoryReviewed`, `directAccessReviewed`, `writers`,
`credentialMetadataReviewed`, `contentManifestSha256`, `backupSha256` and
`restoreProofSha256`. Preserve omitted endpoint semantics from the live registry.
Unknown fields, overlap, missing evidence and changed plan hashes are rejected.

```sh
node packages/mcp-server/dist/workspace-migration.js plan /private/inventory.json
node packages/mcp-server/dist/workspace-migration.js verify-plan \
  /private/inventory.json REVIEWED_PLAN_SHA256
# Stop only the MCP daemon before the following offline control-plane writes.
node packages/mcp-server/dist/workspace-migration.js apply \
  /private/inventory.json REVIEWED_PLAN_SHA256 /private/workspace-control central
node packages/mcp-server/dist/workspace-migration.js apply \
  /private/inventory.json REVIEWED_PLAN_SHA256 /private/workspace-control wiki-fin
# Recovery archives the binding and revokes its workspace grants; no content restore.
node packages/mcp-server/dist/workspace-migration.js rollback \
  /private/inventory.json REVIEWED_PLAN_SHA256 /private/workspace-control central
```

Planning exits 0 for rehearsal-ready, 3 for readiness blockers, or 2 for invalid
input/drift. Applying requires the same reviewed hash, verified numeric Owner
and exclusive control-store lock. It saves a private pre-plan control checkpoint,
then adds one workspace + Owner atomically. Repeating the exact plan is
idempotent. A rolled-back import cannot be silently revived. No content is moved,
no old credential is changed, and no browser session or MCP grant is created.

Rehearse apply/reapply/rollback against isolated restored data first. Back up wiki
content and private control/auth/config state separately. A live per-object copy
is not a globally frozen snapshot: record that limitation; never restore it over
post-cutover writes. An in-place metadata-only cutover needs no legacy content
writer replacement. Preserve Obsidian, snapshot/FUSE jobs and trusted-host grants.
Broad direct storage/Git credentials remain operator authority outside web/MCP
membership; do not distribute them to new workspace members. The reviewer demo
is independent and must not be included in the two-wiki import by accident.

After multi-user use begins, preserve the workspace-capable binary and current
control state during recovery. Disabling the feature or restoring old control
state is not an authorization-safe rollback. Archive only the affected binding
and keep its content, audit, memberships and revoked-grant evidence.

## Verification

Run the MCP package tests, typecheck and build. Automated tests cover local
identity/state, provisioning failure/retry, namespace/symlink denial, strict
invitations, last Owner, scoped consent/token/MCP calls, legacy compatibility,
read-only denial, membership reduction, refresh replay, discovery and private
terminal profiles, and migration drift. Actual Muse/native connector integration,
real GitHub sign-in, production S3/backup/Obsidian integration and migration
rehearsal remain separate checks. Record their actual deployment receipts; local
HTTP test success alone does not prove them.
