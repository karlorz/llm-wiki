# llm-wiki Context

Domain language for SkillWiki project-work lifecycle, evidence, and knowledge ownership.

## Language

**Delivery lifecycle**:
The state of approved work from `planned` through `in-progress` to `completed` or `abandoned`. Work-item `status` describes delivery, not every possible future observation.

**Required acceptance verification**:
Evidence that must pass before delivery is complete. A failed or missing required acceptance check keeps the work active.

**Post-release verification**:
Optional evidence gathered after delivery is already complete. It does not keep a delivered work item active.

**Verification posture**:
The policy controlling whether post-release verification is expected. The supported posture is `opt-in`.

**Verification trigger**:
An event that resurfaces opt-in verification: a matching regression report, an explicit user request, or a relevant code or release change after the last proof.

**New host**:
A machine that should write the wiki for the first time. A new chat tab on an already-provisioned machine is not a new host. A newly created VM that will write is a new host. Creating the machine is not issuance.
_Avoid_: new environment, new user, new session, new workspace

**Writer identity**:
The audited principal behind every HTTP MCP write. It is realized either by a host-id bearer (one machine) or by an OAuth grant (a web client with no host, such as ChatGPT web). Every write, audit line, and allowlist decision names exactly one writer identity.
_Avoid_: user, account, session, connector

**Host-id bearer**:
Operator-issued HTTP MCP authentication bound to one host identity; one realization of a writer identity. The client holds it in process environment or host Configure; the vault never stores the raw value.
_Avoid_: API key, plugin token, session token

**Attended issuance**:
An operator action that creates a host-id bearer, shows the raw value once, and does not write client config files. Surfaces: metal CLI `skillwiki mcp-auth issue-host`, or the loopback `/console` Issue form over an SSH tunnel. Same token-map hash rules.
_Avoid_: auto-provision, first-run wizard, doctor apply, public Caddy `/console`

**Full MCP read/write**:
Live HTTP MCP tools include capture, work-item write, and page publish. A local vault mirror is optional for reads.
_Avoid_: captures-only, local git writer

**Fetch-only leaf**:
`vault_sync.installed=true`, role leaf, `vault_sync.push_enabled=false`. wiki-fetch is required; wiki-push is not part of the host profile.
_Avoid_: HTTP MCP leaf, MCP-healthy host, disabled-push heuristic

**Push-enabled leaf**:
`vault_sync.installed=true`, role leaf, `vault_sync.push_enabled` true or absent. wiki-push remains required. macos-dev stays here.
_Avoid_: treating every HTTP MCP host as fetch-only

**HTTP MCP writer**:
Agent writes go through HTTP MCP. Orthogonal to the vault-sync job profile.
_Avoid_: HTTP MCP leaf as a doctor profile name

**vault_sync.push_enabled**:
Explicit host-profile flag. Absent means true.
_Avoid_: inferring from timer state, fleet.yaml class, or `--check-mcp` pass

**Compact activation**:
A fresh MCP client learns the SkillWiki operating contract from `initialize.instructions` plus one `wiki_context` call, without plugin or skill files.
_Avoid_: session start hook, skill injection, activation file

**Accuracy oracle**:
Independent HTTP MCP reads from a host-id bearer used to check ChatGPT-visible tool results for path, sha256, and canary text.
_Avoid_: screenshot-only check, ChatGPT self-report

**HTTP MCP 401**:
`/mcp` without a bearer, or with a bearer that is not in the token-map (and not a live OAuth grant), returns 401 `unauthorized` with `WWW-Authenticate: Bearer` before any tool runs. The body has no page markdown and no invented writer_id.
_Avoid_: 200 with empty tools, leaking vault bytes on auth failure

**HTTP MCP invalid JSON**:
POST `/mcp` with a valid bearer and a body that is not JSON returns 400 `{ error: "invalid_json" }` before tools. No vault file is written and no writer_id is invented. The daemon stays up.
_Avoid_: uncaught parse crash, 200 with empty tools, inventing writer_id

**Reconcile-not-ready**:
After a valid writer is accepted, tools still return `TOOLS_NOT_READY` until the first S3 reconcile completes. Same envelope as `wiki_context`: `ok: false`, `isError: true`. Reads and writes do not invent a Doubao `writer_id`.
_Avoid_: serving working-copy bytes before reconcile, treating 401 as the gate

**Read receipt**:
The `wiki_read_page` HTTP payload. Success sha256 is the UTF-8 digest of the full file bytes (not the tail slice). Missing paths are `FILE_NOT_FOUND`. Escape attempts are `PATH_DENIED`. `tail_bytes` returns a suffix of a small or oversized page; sha256 stays the full-file digest. No `writer_id` on this receipt.
_Avoid_: hashing only the tail, treating PAGE_TOO_LARGE as the only tail test, inventing writer_id

**Status receipt**:
The `wiki_status` HTTP payload. It reports daemon health (`ok`, `reconcile_ready`, `s3_ok`) plus the authenticated writer as both `writer_id` and `host_id`. A `fleet` object is always present on success (`identity_status` known|unknown|invalid). Optional `host_id` must match the authenticated writer. Unknown host-id, empty/whitespace host-id, and missing host identity fail closed (`USAGE`) with no `fleet` and no other-host leak. Do not invent a Doubao `writer_id`.
_Avoid_: treating vault page counts as identity, leaking sg01 from fleet.yaml on a failed status, inventing chatgpt-web

**Capture validation**:
HTTP `wiki_capture` accepts only `kind` `task|idea|bug|note` and a vault project slug plus non-empty `title` and `content`. Unknown project, empty project, and whitespace project fail closed (`USAGE`). No transcript is written and no `writer_id` is invented.
_Avoid_: writing a file then rejecting, inventing Doubao writer_id on a failed capture, treating inbox as a project

**Workitem path deny**:
HTTP `wiki_workitem_write` is allowlisted to Layer-3 work and workspace markdown. `inbox/`, `raw/`, and `projects/*/history/` are `PATH_DENIED`. No file is written and no `writer_id` is invented.
_Avoid_: treating inbox as a work folder, writing raw via workitem, inventing Doubao writer_id on deny

**Write receipt**:
The success payload a mutating MCP tool returns to the calling client. A capture write receipt must include the writer identity so a web client can prove who wrote without reading the audit file. Overwrite success for `wiki_workitem_write` and `wiki_page_publish` is `{ ok, path }` only — do not invent a Doubao `writer_id` on those receipts.
_Avoid_: audit line, session user, inventing writer_id on CAS overwrite

**HTTP CAS receipt**:
The HTTP `/mcp` tools/call envelope for compare-and-swap overwrites. Stale `base_sha256` returns `FILE_CHANGED` with `currentVersion` `sha256:<hex>` of current file bytes and does not write. Omitting `base_sha256` on an existing path, or sending empty/whitespace `base_sha256`, is `USAGE` and does not write. A `base_sha256` on an absent path is `FILE_CHANGED` with `currentVersion` `sha256:absent` and does not create. Matching `base_sha256` overwrites and the next `wiki_read_page` sha256 matches the new bytes. When S3 and the working copy diverge, `currentVersion` is the S3 hash and the working copy refreshes to S3 before the retry. Unit `cas.test.ts` / `versions.test.ts` are not this lock; `envelope.test.ts` is.
_Avoid_: treating function-level CAS as the HTTP receipt, inventing Doubao writer_id

**Context project**:
Optional HTTP `wiki_context.project` filters the projects list to one vault slug. Omit it to list all. Unknown project, empty project, and whitespace project fail closed (`USAGE`). Failure omits `writer_id` and `projects` and writes no vault file.
_Avoid_: silently ignoring project, inventing a Doubao writer_id on a failed context call

**Compact activation proof**:
A client-visible digest on `wiki_context.compact_activation` that matches the UTF-8 sha256 and byte length of that same session’s `initialize.instructions`. Used when the client UI hides initialize. Local tests pair the two calls; live Doubao trends attach is a separate proof.
_Avoid_: screenshot of system prompt, full instructions echo, treating 最近-chat success as trends PASS

**Operator console**:
Daemon-rendered HTML on `/console` (not `/mcp`) for host-id issue/revoke, fleet hosts, and MCP audit. Gate: loopback remote **and** Host `localhost` / `127.0.0.1` / `::1` (including `[::1]`). Host `localhost` without a port still serves HTML. Missing or empty Host from loopback still refuses. Public Host is 404. `X-Forwarded-For` does not change that gate (public Host still 404; loopback Host still HTML). `Authorization` on `/console` does not substitute for the form: a sibling bearer still issues or revokes the body `host_id`. Routes: GET `/console` (`?page=`, 20 newest-first; `page=0`/`999`/`-1`/`foo`/`1.5` clamp), POST `/console/issue`, POST `/console/revoke` (`confirm` must be exactly `1`). Trailing slash on those POST paths still issues or revokes. POST `/console/issue?page=0`, `/console/issue/?page=0`, `/console/issue?page=1`, `/console/issue?foo=1`, `/console/issue?page=-1`, `/console/issue?bar=2`, `/console/issue?foo=1&bar=2`, `/console/issue?page=999`, `/console/issue?page=foo`, `/console/issue?page=1.5`, `/console/issue/?foo=1`, `/console/issue/?bar=2`, `/console/issue/?page=1`, `/console/issue/?page=2`, `/console/issue/?foo=1&bar=2`, `/console/issue?page=2`, `/console/issue/?page=-1`, `/console/issue/?page=999`, `/console/issue/?page=foo`, `/console/issue/?page=1.5`, `/console/issue?foo=1&page=0`, `/console/issue?page=0&foo=1`, and `/console/issue?confirm=1` still issue. POST `/console/revoke?page=0`, `/console/revoke?foo=1`, `/console/revoke/?page=0`, `/console/revoke?page=1`, `/console/revoke?page=-1`, `/console/revoke?bar=2`, `/console/revoke?foo=1&bar=2`, `/console/revoke?page=999`, `/console/revoke?page=foo`, `/console/revoke?page=1.5`, `/console/revoke/?foo=1`, `/console/revoke/?bar=2`, `/console/revoke/?page=1`, `/console/revoke/?page=2`, `/console/revoke/?foo=1&bar=2`, `/console/revoke?page=2`, `/console/revoke/?page=-1`, `/console/revoke/?page=999`, `/console/revoke/?page=foo`, and `/console/revoke/?page=1.5` still revoke. Query `confirm=1` or `host_id` does not satisfy the POST body; POST `/console/revoke?confirm=1` with body `host_id` only, POST `/console/revoke?confirm=1` with body `confirm=0`, and POST `/console/revoke?host_id=…&confirm=1` with an empty body, still refuse. POST `/console/issue?host_id=…` and POST `/console/issue/?host_id=…` with an empty body still refuse. POST `/console/issue?host_id=sg99` and POST `/console/issue/?host_id=sg99` with body `host_id=` still refuse. POST `/console/issue?host_id=sg99` with body `host_id=%20` still refuses. POST `/console/issue/?host_id=sg99` with body `host_id=%20`, and both paths with body `host_id=%20%20`, `host_id=` plus spaces, `host_id=%09`, `host_id=%0a`, `host_id=+`, or `host_id=++`, still refuse. POST `/console/revoke?host_id=macos-dev&confirm=1` with body `host_id=%20&confirm=1` still refuses. Slash and extra-whitespace revoke variants still refuse. POST `/console/revoke?host_id=macos-dev&confirm=1` with body `host_id=%09&confirm=1` or `host_id=%0a&confirm=1` still refuses. POST `/console/revoke?host_id=macos-dev&confirm=1` with body `host_id=+&confirm=1` still refuses. Slash and `++` variants still refuse. Body `confirm=+` still refuses even when body `host_id` is valid. POST `/console/revoke?confirm=+` and POST `/console/revoke/?confirm=+` with body `host_id=macos-dev&confirm=1` still revoke. POST `/console/revoke?confirm=%20` with the same body still revokes. POST `/console/revoke?confirm=%31` with body `host_id` only still refuses — encoded query `1` does not satisfy the form. POST `/console/revoke/?confirm=%31` with body `host_id` only still refuses. POST `/console/revoke?confirm=%31` with body `host_id=macos-dev&confirm=1` still revokes. POST `/console/revoke/?confirm=%31` with body `host_id=macos-dev&confirm=1` still revokes. POST `/console/issue?confirm=%31` with body `host_id=sg35` still issues. POST `/console/issue/?confirm=%31` with body `host_id=sg36` still issues. POST `/console/revoke?confirm=%32` and POST `/console/revoke/?confirm=%32` with body `host_id` only still refuse — encoded query `2` does not satisfy the form. POST `/console/revoke?confirm=%32` and POST `/console/revoke/?confirm=%32` with body `host_id=macos-dev&confirm=1` still revoke. POST `/console/revoke?confirm=%30` and POST `/console/revoke/?confirm=%30` with body `host_id` only still refuse — encoded query `0` does not satisfy the form. POST `/console/revoke?confirm=%30` and POST `/console/revoke/?confirm=%30` with body `host_id=macos-dev&confirm=1` still revoke. POST `/console/issue?confirm=%32` with body `host_id=sg37` still issues. POST `/console/issue/?confirm=%32` with body `host_id=sg38` still issues. POST `/console/issue?confirm=%30` with body `host_id=sg39` still issues. POST `/console/issue/?confirm=%30` with body `host_id=sg40` still issues. POST `/console/issue?confirm=%33` with body `host_id=sg41` still issues. POST `/console/issue/?confirm=%33` with body `host_id=sg42` still issues. POST `/console/revoke?confirm=%33` and POST `/console/revoke/?confirm=%33` with body `host_id` only still refuse — encoded query `3` does not satisfy the form. POST `/console/revoke?confirm=%33` and POST `/console/revoke/?confirm=%33` with body `host_id=macos-dev&confirm=1` still revoke. POST `/console/issue?confirm=%34` with body `host_id=sg43` still issues. POST `/console/issue/?confirm=%34` with body `host_id=sg44` still issues. POST `/console/revoke?confirm=%34` and POST `/console/revoke/?confirm=%34` with body `host_id` only still refuse — encoded query `4` does not satisfy the form. POST `/console/revoke?confirm=%34` and POST `/console/revoke/?confirm=%34` with body `host_id=macos-dev&confirm=1` still revoke. POST `/console/issue?confirm=%35` with body `host_id=sg45` still issues. POST `/console/issue/?confirm=%35` with body `host_id=sg46` still issues. POST `/console/revoke?confirm=%35` and POST `/console/revoke/?confirm=%35` with body `host_id` only still refuse — encoded query `5` does not satisfy the form. POST `/console/revoke?confirm=%35` and POST `/console/revoke/?confirm=%35` with body `host_id=macos-dev&confirm=1` still revoke. POST `/console/issue?confirm=%36` with body `host_id=sg47` still issues. POST `/console/issue/?confirm=%36` with body `host_id=sg48` still issues. POST `/console/revoke?confirm=%36` and POST `/console/revoke/?confirm=%36` with body `host_id` only still refuse — encoded query `6` does not satisfy the form. POST `/console/revoke?confirm=%36` and POST `/console/revoke/?confirm=%36` with body `host_id=macos-dev&confirm=1` still revoke. POST `/console/issue?confirm=%37` with body `host_id=sg49` still issues. Remaining encoded confirm queries (`/?confirm=%37`, `%38`, `%39`, `%2b`, `%37&page=0`, `%37&foo=1`, `%25`, `%41`, slash and no-slash) still issue. Those same revoke query-only paths still refuse; valid body still revokes. Encoded `%61` (`a`), `%3d` (`=`), `%26` (`&`), `%7e` (`~`), `%2f` (`/`), `%2a` (`*`), `%23` (`#`), `%40` (`@`), `%5b` (`[`), `%5d` (`]`), `%7c` (`|`), and `%3f` (`?`) query-confirm issue and revoke leftovers follow the same body-only rule. Confirm as a later query param (`?page=0&confirm=%37`, `?foo=1&confirm=%37`, `?page=2&confirm=%37`, `?bar=2&confirm=%37`, `?baz=3&confirm=%37`, `?qux=4&confirm=%37`, slash, RFC 3092 names through `thud`, `spam`/`eggs`/`ham`, confirm-first extras, and stacked `foo`/`bar`/`baz`/`qux`) still issues or still refuses query-only revoke. POST `/console/issue?qux=4&confirm=%37` with empty or whitespace body `host_id` still refuses. POST `/console/revoke?qux=4&confirm=%37` and slash with body `confirm=0` still refuse. Extra param plus `%38`/`%39` confirm encodings, and short leftovers `n`/`m`/`p`/`q`/`r`/`s`/`t`/`u` through `z`, `aa`–`az`, `ba`–`bz`, and `aa`–`zz`, still issue or still refuse query-only revoke. POST `/console/issue?ha=1&confirm=%37` with empty body `host_id` still refuses. POST `/console/revoke?ha=1&confirm=%37` with body `confirm=0` still refuses. POST `/console/issue?ha=1&confirm=%38` still issues. Empty body `host_id` on that path still refuses. POST `/console/revoke?ha=1&confirm=%38` with body `confirm=0` still refuses. POST `/console/issue?ha=1&confirm=%39` still issues. Empty body `host_id` on that path still refuses. POST `/console/revoke?ha=1&confirm=%39` with body `confirm=0` still refuses. POST `/console/issue?ha=1&confirm=%3a` still issues. Empty body `host_id` on that path still refuses. POST `/console/revoke?ha=1&confirm=%3a` with body `confirm=0` still refuses. POST `/console/issue?ha=1&confirm=%3b` still issues. Empty body `host_id` on that path still refuses. POST `/console/revoke?ha=1&confirm=%3b` with body `confirm=0` still refuses. POST `/console/issue?ha=1&confirm=%3c` still issues. Empty body `host_id` on that path still refuses. POST `/console/revoke?ha=1&confirm=%3c` with body `confirm=0` still refuses. POST `/console/issue?ha=1&confirm=%3d` still issues. Empty body `host_id` on that path still refuses. POST `/console/revoke?ha=1&confirm=%3d` with body `confirm=0` still refuses. POST `/console/issue?ha=1&confirm=%3e` still issues. Empty body `host_id` on that path still refuses. POST `/console/revoke?ha=1&confirm=%3e` with body `confirm=0` still refuses. Remaining `?ha=1&confirm=` encodings `%3f`–`%8f` (slash and no-slash) still issue; empty body `host_id` still refuses; matching revoke with body `confirm=0` still refuses. Encoding walk `%90`–`%ff` is stopped. POST `/console/issue?aaa=1&confirm=%37` still issues. POST `/console/issue` with `charset=utf-8`, `charset=UTF-8`, quoted `charset="utf-8"`, `text/plain` plus a urlencoded body, `application/octet-stream` plus a urlencoded body, `multipart/form-data` plus a urlencoded body, without Content-Type, with `Content-Type: application/json` plus a urlencoded `host_id` body, with an unused extra body field (before or after `host_id`), or with a repeated `host_id` (first value wins) still issues. A JSON object body still refuses. POST `/console/issue` with `Accept: application/json` still returns HTML. GET `/console` with `Accept: application/json` still returns HTML. GET `/console/` with `Accept: application/json` still returns HTML. GET `/console/issue` with `Accept: application/json` still 302s to `/console`. GET `/console/revoke` with `Accept: application/json` still 302s to `/console`. POST `/console/revoke` with `Accept: application/json` still returns HTML. POST `/console/revoke` with an unused extra body field, or with `text/plain` plus a urlencoded body, still revokes. Empty body `host_id` on that path still refuses. POST `/console/revoke?aaa=1&confirm=%37` with body `confirm=0` still refuses. POST `/console/issue?u=1&confirm=%37` with empty body `host_id` still refuses. POST `/console/revoke?u=1&confirm=%37` with body `confirm=0` still refuses. Slash, `%09`, `%0a`, and `++` query-confirm variants still revoke. POST `/console/issue?confirm=%20` with body `host_id=sg29` still issues. Slash, `%09`, `%0a`, and `++` query-confirm issue variants still issue. POST `/console/issue?host_id=+` with body `host_id=sg27` issues `sg27`, not the query host-id. POST `/console/issue/?host_id=+` with body `host_id=sg28` issues `sg28`, not the query host-id. POST `/console/issue?host_id=sg99` and POST `/console/issue/?host_id=sg99` with body `host_id=sg26` issue `sg26`, not the query host-id. POST `/console/revoke/?confirm=1` with body `confirm=0`, and POST `/console/revoke/?host_id=…&confirm=1` with an empty body, still refuse. POST `/console/revoke?host_id=sg02&confirm=1` and POST `/console/revoke/?host_id=sg02&confirm=1` with body `host_id=macos-dev&confirm=1` revoke `macos-dev`, not the query host-id. POST `/console/revoke?host_id=macos-dev&confirm=1` and POST `/console/revoke/?host_id=macos-dev&confirm=1` with body `confirm=1` only still refuse. A double or triple slash (`/issue//`, `/issue///`, `/revoke//`, `/revoke///`) is HTML 404. POST `/console` on the bare path, `/console/` trailing slash, `/console//`, or `/console///` is HTML 404. GET `/console/` is 200; GET `/console//` and `/console///` are HTML 404. GET issue/revoke 302 to `/console`. GET `/console/issue?foo=1`, `/console/revoke?foo=1`, `/console/issue/?foo=1`, `/console/revoke/?foo=1`, `/console/issue?bar=2`, `/console/revoke?bar=2`, `/console/issue?foo=1&bar=2`, `/console/revoke?foo=1&bar=2`, `/console/issue?page=2`, `/console/revoke?page=2`, `/console/issue/?page=2`, `/console/revoke/?page=2`, `/console/issue?page=1`, `/console/revoke?page=1`, `/console/issue/?page=1`, `/console/revoke/?page=1`, `/console/issue?page=0`, `/console/revoke?page=0`, `/console/issue/?page=0`, `/console/revoke/?page=0`, `/console/issue?page=-1`, `/console/revoke?page=-1`, `/console/issue?page=999`, `/console/revoke?page=999`, `/console/issue?page=foo`, `/console/revoke?page=foo`, `/console/issue?page=1.5`, and `/console/revoke?page=1.5` are still that 302. OPTIONS `/console/issue?page=2`, `/console/revoke?page=2`, `/console/issue/?page=2`, `/console/revoke/?page=2`, `/console/issue?page=1`, `/console/revoke?page=1`, `/console/issue?page=0`, `/console/revoke?page=0`, `/console/issue?page=-1`, `/console/revoke?page=-1`, `/console/issue?page=999`, `/console/revoke?page=999`, `/console/issue?page=foo`, `/console/revoke?page=foo`, `/console/issue?page=1.5`, and `/console/revoke?page=1.5` are HTML 404, not that 302. TRACE / HEAD / PUT / PATCH / DELETE on `/console/issue?page=2` and `/console/revoke?page=2` are 404 (HEAD empty body), not that 302. OPTIONS `/console/issue?foo=1`, `/console/revoke?foo=1`, `/console/issue/?foo=1`, `/console/revoke/?foo=1`, `/console/issue?bar=2`, `/console/revoke?bar=2`, `/console/issue?foo=1&bar=2`, `/console/revoke?foo=1&bar=2`, `/console/revoke?confirm=1`, `/console/issue?confirm=1`, `/console/revoke?host_id=macos-dev&confirm=1`, `/console/issue?host_id=sg99`, `/console/revoke/?confirm=1`, `/console/issue/?confirm=1`, `/console/revoke/?host_id=macos-dev&confirm=1`, and `/console/issue/?host_id=sg99` are HTML 404, not that 302. TRACE / HEAD / PUT / PATCH / DELETE on `/console/revoke?confirm=1`, `/console/issue?confirm=1`, `/console/issue?host_id=sg99`, `/console/revoke/?confirm=1`, `/console/issue/?confirm=1`, and `/console/issue/?host_id=sg99` are 404 (HEAD empty body), not that 302. TRACE / HEAD / PUT / PATCH / DELETE on `/console/issue?bar=2` and `/console/revoke?bar=2` are 404 (HEAD empty body), not that 302. TRACE / HEAD / PUT / PATCH / DELETE on `/console/issue?foo=1`, `/console/revoke?foo=1`, `/console/issue/?foo=1`, and `/console/revoke/?foo=1` are 404 (HEAD empty body), not that 302. GET `/console/issue//`, `/console/issue///`, `/console/revoke//`, and `/console/revoke///` are 404, not that 302. HEAD on `/console/issue` and `/console/revoke` is 404, not that 302. HEAD `/console/issue/`, `/console/issue//`, `/console/issue///`, `/console/revoke/`, `/console/revoke//`, and `/console/revoke///` are 404 (empty body), not the GET 302. HEAD `/console/`, `/console//`, and `/console///` are 404 (empty body), not the GET 200. Unknown `/console/*` is HTML 404 and still includes the skip-to-main link (`href="#main"`). GET `/console` and POST `/console/issue` success HTML include that skip link and `aria-current="page"` on Console. `PATCH` / `PUT` / `DELETE` / `HEAD` / `OPTIONS` / `TRACE` `/console` on loopback is HTML 404. PUT `/console/`, `/console//`, and `/console///` and PATCH `/console/`, `/console//`, and `/console///` are HTML 404. DELETE `/console/`, `/console//`, and `/console///` are HTML 404. OPTIONS `/console/`, `/console//`, and `/console///` are HTML 404. OPTIONS `/console/issue`, `/console/issue/`, `/console/issue//`, `/console/issue///`, `/console/revoke`, `/console/revoke/`, `/console/revoke//`, and `/console/revoke///` are HTML 404, not the GET 302. TRACE `/console/`, `/console//`, and `/console///` are HTML 404. TRACE `/console/issue`, `/console/issue/`, `/console/issue//`, `/console/issue///`, `/console/revoke`, `/console/revoke/`, `/console/revoke//`, and `/console/revoke///` are HTML 404, not the GET 302. PUT `/console/issue`, `/console/issue/`, `/console/issue//`, `/console/issue///`, `/console/revoke`, `/console/revoke/`, `/console/revoke//`, and `/console/revoke///` are HTML 404, not the GET 302. PATCH `/console/issue`, `/console/issue/`, `/console/issue//`, `/console/issue///`, `/console/revoke`, `/console/revoke/`, `/console/revoke//`, and `/console/revoke///` are HTML 404, not the GET 302. DELETE `/console/issue`, `/console/issue/`, `/console/issue//`, `/console/issue///`, `/console/revoke`, `/console/revoke/`, `/console/revoke//`, and `/console/revoke///` are HTML 404, not the GET 302. V1 surfaces are keys (host-id, fingerprint, Enabled, issued count), devices (first seen / last active from audit; Unmapped has no revoke), and usage (when/tool/writer/path/result/ms). Quota strip and model-calls stay hidden. Fields as-is from the token-map and audit JSONL. Bearer is shown once; the map stores a hash only. Audit load failure shows Retry. Reach after deploy via SSH tunnel to the daemon loopback; do not add a public Caddy `/console`. Revoke of a mapped host-id removes that key only; other issued keys stay. After revoke, the same host-id can be issued again (new hash) without dropping a sibling key. Host-id length is 2–63 (`[a-z][a-z0-9-]{1,62}`). A colliding hash on issue is 400 and leaves the map unchanged. Empty or whitespace host-id on revoke is 400 and leaves the map unchanged. Invalid host-id on revoke is 400 confirmation copy, not not-found. Revoke of an unknown host-id is 400 and leaves the map unchanged.
_Avoid_: Kimi console, cursor-box-channel `/console`, Caddy vhost for `/console`

**Composer chip bind**:
In Doubao Work, `@` → 連接器 opens the account connector picker. That is not project attachment. 專案 / trends chips that are `actionUnsupported` leave a proof chat under 最近.
_Avoid_: treating connector enable as trends scope, Path A fallback as compact PASS

**Query scope**:
`wiki_query` / CLI `--scope` pool: `typed` (default, Layer-2 only), `work` (Layer-3 `projects/*/work/*`), `all` (merge). Setup, doctor, and open-work questions use `work` / `all` or `wiki_context`, not default typed. HTTP `scope=work` ranks Layer-3 work first and omits typed `queries/`; a known project still queries. HTTP unknown scope, empty scope, and whitespace scope fail closed (`USAGE` or JSON-RPC invalid params). No `writer_id` is invented and no vault file is written.
_Avoid_: treating typed ranking as a work-item search, inventing a fourth scope, silently defaulting empty scope to typed

**Query project**:
Optional HTTP `wiki_query.project` must be a vault slug that exists under `projects/`. Omit it to query the whole vault. Unknown project, empty project, and whitespace project fail closed (`USAGE`). Failure omits `writer_id` and `results` and writes no vault file.
_Avoid_: inventing a Doubao writer_id on a failed query, silently defaulting empty project

**Event ledger**:
Immutable `skillwiki-log-event/v1` JSON under `meta/log-events/`. Backend operation records on the live S3 vault, not Layer-2 wiki notes.
_Avoid_: user content, notes, treating `log.md` as the SSOT

**Authoritative S3 ownership**:
The live vault paths transported to S3 by leaf `wiki-push`. This includes `meta/log-events/**`; Git ignore and Git promotion rules do not decide S3 durability.
_Avoid_: reusing snapshot excludes or Git presentation rules as S3 deletion/omission rules

**Markdown inventory**:
The `.md` files returned by `scanVault()`, after Git-standard ignore handling for a Git-backed root. Event JSON is read separately by `readLogEvents()` and is never part of `VaultScan`.
_Avoid_: adding ledger JSON to `VaultScan`, treating `git check-ignore` as an S3 ownership predicate

**Promotable note**:
A vault path the snapshot 200-cap treats as GitHub-bound user content.
_Avoid_: counting event-ledger JSON as notes

**Classified inventory**:
The snapshot-side Git promotion class shared by its 200-cap, S3-to-Git rclone excludes, and pathspec-scoped `git add`. Event ledger and local scratch are non-promotable; user pages remain promotable.
_Avoid_: raising the 200-cap, `git add -A` of leftover event-ledger JSON, applying this class to leaf S3 push

**Fetch projection**:
An independent sibling Git clone selected by `vault_sync.fetch_projection` for leaf fetch, operator Git status, and `copy-status.local_git`. It contains GitHub-promotable content only and is distinct from the authoritative live vault and the snapshotter worktree.
_Avoid_: linked worktree, reusing `vault_sync.snapshot_worktree`, redirecting MCP/authoring writes into the projection

**Git presentation**:
The operator-visible Git state of the fetch projection. Projection dirt and authoritative live drift are separate signals; neither determines whether live ledger data is durable in S3.
_Avoid_: reporting live event JSON as projection Git dirt, hiding all untracked content with `status.showUntrackedFiles=no`

**Path-class predicates**:
CLI code names the four planes independently: `isS3OwnedPath`, `isMarkdownInventoryPath`, `isGitPromotablePath`, and `isGitPresentationPath`. Snapshot shell uses `scripts/lib/git-promotion-policy.sh`; an executable parity test keeps its Git-promotion decisions aligned with the CLI without reusing that policy for S3 transport.
_Avoid_: substituting Git-promotion exclusions for S3 ownership, or treating Markdown extension membership as Git-ignore state

**Query text**:
HTTP `wiki_query.query` must be non-empty after trim. Whitespace-only query fail-closes (`USAGE`). No `results`, no invented `writer_id`, no vault file written.
_Avoid_: treating spaces as a ranked query, inventing a Doubao writer_id



**Memory recall scope**:
HTTP `wiki_memory_recall` `scope` enum is `project` | `global` | `all`. CLI `skillwiki memory recall` also has `cross-agent`. An unknown HTTP scope (including `cross-agent`), empty scope, and whitespace scope fail-close; they do not default. Missing cache is ok with empty `sources` and an advisory `humanHint`.
_Avoid_: treating CLI cross-agent as an HTTP MCP scope, silently defaulting bad or empty scope to project

**Ranked audit report**:
A read-only evidence packet that classifies active project work without changing lifecycle state.

**Lifecycle reconciliation**:
An attended decision process that reviews ranked-audit evidence, resolves ambiguous verdicts, and applies approved lifecycle corrections only after final batch approval.

## Relationships

- Delivery lifecycle owns active-work ranking eligibility.
- Required acceptance verification is part of delivery lifecycle.
- Post-release verification follows delivery lifecycle and is governed by verification posture and triggers.
- Ranked audit reports inform lifecycle reconciliation but do not authorize mutation.
- SkillWiki owns lifecycle truth, validation, evidence shape, and managed vault mutation; orchestration systems consume those contracts.
- Writer identity is resolved once per HTTP MCP request; host-id bearer and OAuth grant are its two realizations and neither changes what a write may touch.
- HTTP MCP writer is orthogonal to fetch-only leaf vs push-enabled leaf.
- vault_sync.push_enabled selects the vault-sync job profile on an installed leaf.
- Operator console mutates the same token-map and reads the same audit JSONL as CLI `mcp-auth`; it is attended issuance over SSH, not a second writer identity.
- Composer chip bind is Doubao project attachment; it is not HTTP MCP compact activation and does not change writer identity.
- Query scope is independent of compact activation and of composer chip bind; default typed never implies work-item search. HTTP scope=work ranks Layer-3 work first. Unknown or empty HTTP scope fail-closes and does not invent a writer_id.
- Query project is an optional wiki_query filter; unknown or empty project fail-closes and does not invent a writer_id.
- Query text must be non-empty after trim; whitespace-only HTTP query fail-closes and does not invent a writer_id.
- Authoritative S3 ownership, Markdown inventory, snapshot Git promotion, and Git presentation are separate predicates. Event ledger is S3-owned and Git-non-promotable; promotable notes are GitHub-bound user content; `log.md` is a projection of the event ledger.
- Fetch projection is the leaf Git presentation/fetch clone; it does not replace the live MCP/S3 vault or the snapshotter's protected worktree.
- HTTP CAS receipt is the `/mcp` envelope for workitem and page-publish overwrites; it does not change writer identity and does not invent a Doubao writer_id.
- Status receipt names the authenticated writer and includes fleet identity on success; unknown or missing host identity fail-closes without leaking other fleet hosts.
- Read receipt sha256 is full-file bytes; tail_bytes is a suffix only; missing and escaped paths fail closed.
- HTTP MCP 401 is decided before tools; reconcile-not-ready is `TOOLS_NOT_READY` after a valid writer.
- Memory recall scope is independent of query scope; HTTP MCP does not accept CLI-only `cross-agent`.
- Capture validation fails closed before any transcript write; a failed capture does not invent a writer_id.
- HTTP MCP invalid JSON is 400 after a valid writer; it does not reach tools and does not invent a writer_id.
- Context project is an optional wiki_context filter; unknown or empty project fail-closes and does not invent a writer_id.
- Workitem path deny is fail-closed before any write; inbox/ and raw/ are not work-item paths.
