import { readFileSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { TokenMap } from "./auth.js";
import { replaceTokenMap } from "./auth.js";
import { appendAudit } from "./audit.js";
import type { ClientEntry, OAuthStore, RefreshTokenEntry } from "./oauth-store.js";
import type { OAuthConfig } from "./oauth.js";
import { hashPassword } from "./oauth.js";
import { writePasswordHashFile } from "./oauth-password-file.js";
import {
  HOST_ID_RE,
  type AppendHostHashError,
  appendHostHash,
  generateHostBearer,
  removeHostId,
} from "./token-map.js";

const ISSUE_ERROR_COPY: Record<AppendHostHashError, string> = {
  INVALID_HOST_ID: "Invalid host-id.",
  DUPLICATE_HOST_ID: "That host-id is already issued.",
  DUPLICATE_HASH: "Could not issue. Retry.",
  INVALID_ALLOWED_VAULTS: "allowed_vaults must be exact vault ids with no wildcards.",
};

export const CONSOLE_PAGE_SIZE = 20;

export interface ConsoleRequestLike {
  socket: { remoteAddress?: string | null };
  headers: { host?: string | string[] };
}

export function isConsolePath(path: string): boolean {
  const normalized = path.replace(/\/+$/, "") || "/";
  return normalized === "/console" || normalized.startsWith("/console/");
}

function hostnameFromHostHeader(host: string): string {
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    return end >= 0 ? host.slice(1, end).toLowerCase() : host.toLowerCase();
  }
  return host.split(":")[0]!.toLowerCase();
}

export function isConsoleRequestAllowed(req: ConsoleRequestLike): boolean {
  const remote = req.socket.remoteAddress ?? "";
  const loopback = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
  const rawHost = Array.isArray(req.headers.host) ? req.headers.host[0] : req.headers.host;
  const host = hostnameFromHostHeader((rawHost ?? "").trim());
  const localHost = host === "localhost" || host === "127.0.0.1" || host === "::1";
  return loopback && localHost;
}

export interface AuditRow {
  ts: string;
  host_id: string;
  tool: string;
  path?: string;
  ok: boolean;
  error?: string;
  ms: number;
}

export function parseAuditLines(text: string): AuditRow[] {
  const rows: AuditRow[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as Partial<AuditRow>;
      if (typeof parsed.ts !== "string" || typeof parsed.host_id !== "string" || typeof parsed.tool !== "string") {
        continue;
      }
      rows.push({
        ts: parsed.ts,
        host_id: parsed.host_id,
        tool: parsed.tool,
        path: typeof parsed.path === "string" ? parsed.path : undefined,
        ok: parsed.ok !== false,
        error: typeof parsed.error === "string" ? parsed.error : undefined,
        ms: typeof parsed.ms === "number" ? parsed.ms : 0,
      });
    } catch {
      // skip malformed
    }
  }
  return rows;
}

export function pageAudit(rows: AuditRow[], page: number, pageSize = CONSOLE_PAGE_SIZE): {
  slice: AuditRow[];
  page: number;
  pages: number;
  total: number;
} {
  const newestFirst = [...rows].reverse();
  const total = newestFirst.length;
  const pages = Math.max(1, Math.ceil(total / pageSize) || 1);
  const safePage = Number.isInteger(page) && page >= 1 ? Math.min(page, pages) : 1;
  const start = (safePage - 1) * pageSize;
  return { slice: newestFirst.slice(start, start + pageSize), page: safePage, pages, total };
}

export function readAuditLog(auditFile: string | undefined): { rows: AuditRow[]; error?: string } {
  if (!auditFile) return { rows: [] };
  try {
    return { rows: parseAuditLines(readFileSync(auditFile, "utf8")) };
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { rows: [] };
    return { rows: [], error: "Could not load audit. Retry." };
  }
}

function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fingerprint(hashHex: string): string {
  return `••••${hashHex.slice(-4)}`;
}

export function formatWhen(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(date);
}

function timeCell(iso: string): string {
  return `<time datetime="${esc(iso)}" title="${esc(iso)}">${esc(formatWhen(iso))}</time>`;
}

interface DeviceRow {
  hostId: string;
  firstSeen: string;
  lastActive: string;
  mapped: boolean;
}

function devicesFromAudit(rows: AuditRow[], map: TokenMap): DeviceRow[] {
  const byHost = new Map<string, { first: string; last: string }>();
  for (const row of rows) {
    const cur = byHost.get(row.host_id);
    if (!cur) {
      byHost.set(row.host_id, { first: row.ts, last: row.ts });
      continue;
    }
    if (row.ts < cur.first) cur.first = row.ts;
    if (row.ts > cur.last) cur.last = row.ts;
  }
  const mapped = new Set(map.values());
  return [...byHost.entries()]
    .map(([hostId, times]) => ({
      hostId,
      firstSeen: times.first,
      lastActive: times.last,
      mapped: mapped.has(hostId),
    }))
    .sort((a, b) => a.hostId.localeCompare(b.hostId));
}

export interface ConsolePageModel {
  tokenMap: TokenMap;
  audit: ReturnType<typeof pageAudit>;
  devices: DeviceRow[];
  oauth?: {
    clients: ClientEntry[];
    grants: RefreshTokenEntry[];
  };
  operatorLogin?: {
    configured: boolean;
  };
  notice?: string;
  onceBearer?: string;
  onceHostId?: string;
  error?: string;
  auditError?: string;
}

export function renderOperatorLoginSection(
  operatorLogin: ConsolePageModel["operatorLogin"],
  opts: { dedicated?: boolean } = {},
): string {
  if (!operatorLogin) return "";
  const configured = operatorLogin.configured;
  const statusBadge = configured
    ? `<span class="muted ok">Configured</span>`
    : `<span class="muted">Unset</span>`;
  if (!opts.dedicated) {
    // Slim row on /console: status plus link only. The form lives on the dedicated page.
    return `
    <div class="row-head">
      <h2>Operator login ${statusBadge}</h2>
      <p class="muted"><a href="/console/operator-login">Open dedicated page</a></p>
    </div>`;
  }

  return `
    <div class="row-head">
      <h2>Operator login ${statusBadge}</h2>
      <form class="issue-form" method="post" action="/console/oauth/set-password">
        <label for="password">New password</label>
        <input id="password" type="password" name="password" required autocomplete="new-password">
        <label for="password_confirm">Confirm</label>
        <input id="password_confirm" type="password" name="password_confirm" required autocomplete="new-password">
        <input type="hidden" name="confirm" value="1">
        <button type="submit">Set password</button>
      </form>
    </div>
    <div class="callout">Save the same value in the host Keychain. Daemon stores a hash only. Grants stay until OAuth access revoke.</div>`;
}

export function renderConsolePage(model: ConsolePageModel): string {
  const issued = [...model.tokenMap.entries()];
  const keysBody =
    issued.length === 0
      ? `<tr><td colspan="4">No host-id bearers. Issue one below or on metal.</td></tr>`
      : issued
          .map(
            ([hash, hostId]) => `<tr>
  <td><code class="clip" translate="no" title="${esc(hostId)}">${esc(hostId)}</code></td>
  <td><code translate="no">${esc(fingerprint(hash))}</code></td>
  <td><span class="ok">Enabled</span></td>
  <td>${revokeForm(hostId)}</td>
</tr>`,
          )
          .join("\n");

  const devicesBody =
    model.devices.length === 0
      ? `<tr><td colspan="4">No hosts have presented a writer identity yet.</td></tr>`
      : model.devices
          .map(
            (d) => `<tr>
  <td><code class="clip" translate="no" title="${esc(d.hostId)}">${esc(d.hostId)}</code>${d.mapped ? "" : (model.oauth ? ' <a href="#oauth-access" class="muted">Unmapped</a>' : ' <span class="muted">Unmapped</span>')}</td>
  <td>${timeCell(d.firstSeen)}</td>
  <td>${timeCell(d.lastActive)}</td>
  <td>${d.mapped ? revokeForm(d.hostId) : ""}</td>
</tr>`,
          )
          .join("\n");

  const auditError = model.auditError
    ? `<p class="bad" role="alert" aria-live="polite">${esc(model.auditError)} <a class="pager-link" href="/console">Retry</a></p>`
    : "";
  const auditBody =
    model.auditError
      ? `<tr><td colspan="6">${esc(model.auditError)}</td></tr>`
      : model.audit.total === 0
        ? `<tr><td colspan="6">No audit rows in this window.</td></tr>`
        : model.audit.slice
            .map((row) => {
              const result = row.ok
                ? `<span class="ok">OK</span>`
                : `<span class="bad" aria-label="${esc(row.error ?? "error")}">${esc(row.error ?? "error")}</span>`;
              return `<tr>
  <td>${timeCell(row.ts)}</td>
  <td><code translate="no">${esc(row.tool)}</code></td>
  <td><code translate="no">${esc(row.host_id)}</code></td>
  <td>${row.path ? `<code class="clip" translate="no" title="${esc(row.path)}">${esc(row.path)}</code>` : ""}</td>
  <td>${result}</td>
  <td class="num">${esc(String(row.ms))} ms</td>
</tr>`;
            })
            .join("\n");

  const once = model.onceBearer
    ? `<section class="callout once">
  <p>The bearer is shown once. Save it in the host’s process env or Configure${model.onceHostId ? ` for <code translate="no">${esc(model.onceHostId)}</code>` : ""}.</p>
  <pre data-once-bearer="${esc(model.onceBearer)}"><code translate="no">${esc(model.onceBearer)}</code></pre>
  <div class="once-actions">
    <button type="button" id="copy-bearer" aria-live="polite">Copy bearer</button>
    <a class="pager-link" href="/console">I saved it</a>
  </div>
</section>`
    : "";

  const err = model.error ? `<p class="bad" role="alert">${esc(model.error)}</p>` : "";
  const prev =
    model.audit.page > 1
      ? `<a class="pager-link" href="/console?page=${model.audit.page - 1}" rel="prev">Previous</a>`
      : `<span class="pager-link muted">Previous</span>`;
  const next =
    model.audit.page < model.audit.pages
      ? `<a class="pager-link" href="/console?page=${model.audit.page + 1}" rel="next">Next</a>`
      : `<span class="pager-link muted">Next</span>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="dark">
  <title>SkillWiki console</title>
  <style>
    :root {
      --background: oklch(0.16 0.01 260);
      --foreground: oklch(0.95 0.01 260);
      --card: oklch(0.2 0.01 260);
      --card-foreground: oklch(0.95 0.01 260);
      --primary: oklch(0.75 0.12 250);
      --destructive: oklch(0.65 0.18 25);
      --accent: oklch(0.28 0.02 260);
      --muted-foreground: oklch(0.7 0.02 260);
      --border: oklch(0.32 0.015 260);
      --ring: oklch(0.75 0.12 250);
      --ok: oklch(0.72 0.15 145);
      --bad: oklch(0.65 0.18 25);
    }
    * { box-sizing: border-box; }
    html { scrollbar-gutter: stable; }
    body { margin: 0; font: 14px/1.45 ui-sans-serif, system-ui, sans-serif; background: var(--background); color: var(--foreground); }
    a { color: var(--primary); }
    a:focus-visible, button:focus-visible, input:focus-visible { outline: none; box-shadow: 0 0 0 3px var(--ring); }
    .skip { position: absolute; left: -999px; }
    .skip:focus { left: 1rem; top: 1rem; }
    .visually-hidden { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); border: 0; }
    code.clip { display: inline-block; max-width: 24rem; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; vertical-align: bottom; }
    header { display: flex; gap: 1.5rem; align-items: center; padding: 0.75rem 1.5rem; border-bottom: 1px solid var(--border); }
    header .brand { font-weight: 700; }
    header a.active { background: var(--accent); color: var(--foreground); padding: 0.2rem 0.5rem; border-radius: 0.375rem; text-decoration: none; }
    main { max-width: 80rem; margin: 0 auto; padding: 1.5rem; }
    h2 { font-size: 1.125rem; margin: 1.75rem 0 0.5rem; }
    .row-head { display: flex; flex-direction: column; align-items: flex-start; gap: 0.75rem; }
    .issue-form { display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap; }
    .muted { color: var(--muted-foreground); font-size: 0.75rem; }
    .callout { background: var(--card); color: var(--muted-foreground); border-radius: 0.5rem; padding: 0.75rem 1rem; font-size: 0.875rem; margin: 0.5rem 0 0.75rem; }
    .once { position: relative; z-index: 1; contain: layout; }
    .once pre { overflow-x: auto; max-width: 100%; margin: 0.5rem 0; white-space: pre-wrap; word-break: break-all; }
    .once-actions { display: flex; flex-wrap: wrap; gap: 0.75rem; align-items: center; }
    table { width: 100%; border-collapse: collapse; font-size: 0.75rem; }
    th { text-align: left; background: color-mix(in oklab, var(--accent) 20%, transparent); padding: 0.4rem 0.5rem; }
    td { padding: 0.4rem 0.5rem; border-top: 1px solid var(--border); vertical-align: top; }
    code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
    .ok { color: var(--ok); }
    .bad { color: var(--bad); }
    .num { font-variant-numeric: tabular-nums; }
    button, .pager-link, input { transition: none !important; animation: none !important; }
    button { background: var(--primary); color: var(--background); border: 0; border-radius: 999px; min-height: 2.25rem; padding: 0.35rem 0.85rem; cursor: pointer; }
    button.danger { background: var(--destructive); color: white; }
    input { background: var(--card); color: var(--foreground); border: 1px solid var(--border); border-radius: 0.375rem; padding: 0.35rem 0.5rem; }
    .pager { display: flex; justify-content: space-between; align-items: center; margin-top: 0.75rem; font-size: 0.875rem; color: var(--muted-foreground); }
    .pager-link { display: inline-block; min-width: 5.5rem; min-height: 2.25rem; line-height: 2.25rem; text-align: center; padding: 0 0.75rem; }
    @media (prefers-reduced-motion: reduce) { *, *::before, *::after { transition: none !important; animation: none !important; } }
  </style>
</head>
<body>
  <a class="skip" href="#main">Skip to main</a>
  <h1 class="visually-hidden">SkillWiki console</h1>
  <header>
    <span class="brand">SkillWiki</span>
    <a href="https://github.com/karlorz/llm-wiki">Docs</a>
    <a class="active" href="/console" aria-current="page">Console</a>
    <a href="/console/operator-login">Operator login</a>
  </header>
  <main id="main">
    ${err}
    <div class="row-head">
      <h2>Host-id bearers <span class="muted">${issued.length} issued</span></h2>
      <form class="issue-form" method="post" action="/console/issue">
        <label for="host_id">Host-id</label>
        <input id="host_id" name="host_id" required spellcheck="false" autocomplete="off" pattern="[a-z][a-z0-9\\-]{1,62}">
        <button type="submit">Issue host-id</button>
      </form>
    </div>
    ${once}
    <div class="callout">The bearer is shown once. Save it in the host’s process env or Configure. The vault stores only a hash. If a leak is suspected, revoke the host-id. Do not paste the value into chat or vault pages.</div>
    <table>
      <thead><tr><th>Host-id</th><th>Fingerprint</th><th>Status</th><th>Actions</th></tr></thead>
      <tbody>${keysBody}</tbody>
    </table>
${renderOperatorLoginSection(model.operatorLogin)}
${renderOAuthSection(model.oauth)}
    <h2>Fleet hosts</h2>
    <div class="callout">Each host-id is one machine. Last active is the last audit row from that writer. Revoke removes the bearer. It does not log the machine out of SSH.</div>
    <table>
      <thead><tr><th>Host-id</th><th>First seen</th><th>Last active</th><th>Actions</th></tr></thead>
      <tbody>${devicesBody}</tbody>
    </table>

    <h2>MCP audit</h2>
    <p class="muted">Tool calls. Writer identity is the audit host_id (host-id bearer or OAuth writer).</p>
    ${auditError}
    <table>
      <thead><tr><th>When</th><th>Tool</th><th>Writer</th><th>Path</th><th>Result</th><th>Latency</th></tr></thead>
      <tbody>${auditBody}</tbody>
    </table>
    <div class="pager">
      <span>${model.audit.total} records</span>
      <span>${prev} ${model.audit.page}/${model.audit.pages} ${next}</span>
    </div>
  </main>
  <script>
    (function () {
      if (document.querySelector("[data-once-bearer]")) {
        history.replaceState(null, "", "/console");
      }
      var btn = document.getElementById("copy-bearer");
      if (!btn) return;
      btn.addEventListener("click", function () {
        var pre = document.querySelector("[data-once-bearer]");
        if (!pre) return;
        var text = pre.getAttribute("data-once-bearer") || "";
        var done = function (ok) { btn.textContent = ok ? "Copied" : "Copy failed"; };
        if (!navigator.clipboard || !navigator.clipboard.writeText) {
          done(false);
          return;
        }
        navigator.clipboard.writeText(text).then(function () { done(true); }).catch(function () { done(false); });
      });
    })();
  </script>
</body>
</html>
`;
}

export function renderOperatorLoginPage(model: ConsolePageModel): string {
  const err = model.error ? `<p class="bad" role="alert">${esc(model.error)}</p>` : "";
  const notice = model.notice ? `<p class="ok" role="status">${esc(model.notice)}</p>` : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="dark">
  <title>SkillWiki console - Operator login</title>
  <style>
    :root {
      --background: oklch(0.16 0.01 260);
      --foreground: oklch(0.95 0.01 260);
      --card: oklch(0.2 0.01 260);
      --card-foreground: oklch(0.95 0.01 260);
      --primary: oklch(0.75 0.12 250);
      --destructive: oklch(0.65 0.18 25);
      --accent: oklch(0.28 0.02 260);
      --muted-foreground: oklch(0.7 0.02 260);
      --border: oklch(0.32 0.015 260);
      --ring: oklch(0.75 0.12 250);
      --ok: oklch(0.72 0.15 145);
      --bad: oklch(0.65 0.18 25);
    }
    * { box-sizing: border-box; }
    html { scrollbar-gutter: stable; }
    body { margin: 0; font: 14px/1.45 ui-sans-serif, system-ui, sans-serif; background: var(--background); color: var(--foreground); }
    a { color: var(--primary); }
    a:focus-visible, button:focus-visible, input:focus-visible { outline: none; box-shadow: 0 0 0 3px var(--ring); }
    .skip { position: absolute; left: -999px; }
    .skip:focus { left: 1rem; top: 1rem; }
    .visually-hidden { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); border: 0; }
    header { display: flex; gap: 1.5rem; align-items: center; padding: 0.75rem 1.5rem; border-bottom: 1px solid var(--border); }
    header .brand { font-weight: 700; }
    header a.active { background: var(--accent); color: var(--foreground); padding: 0.2rem 0.5rem; border-radius: 0.375rem; text-decoration: none; }
    main { max-width: 80rem; margin: 0 auto; padding: 1.5rem; }
    h2 { font-size: 1.125rem; margin: 1.75rem 0 0.5rem; }
    .row-head { display: flex; flex-direction: column; align-items: flex-start; gap: 0.75rem; }
    .issue-form { display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap; }
    .muted { color: var(--muted-foreground); font-size: 0.75rem; }
    .callout { background: var(--card); color: var(--muted-foreground); border-radius: 0.5rem; padding: 0.75rem 1rem; font-size: 0.875rem; margin: 0.5rem 0 0.75rem; }
    .ok { color: var(--ok); }
    .bad { color: var(--bad); }
    button, input { transition: none !important; animation: none !important; }
    button { background: var(--primary); color: var(--background); border: 0; border-radius: 999px; min-height: 2.25rem; padding: 0.35rem 0.85rem; cursor: pointer; }
    input { background: var(--card); color: var(--foreground); border: 1px solid var(--border); border-radius: 0.375rem; padding: 0.35rem 0.5rem; }
  </style>
</head>
<body>
  <a class="skip" href="#main">Skip to main</a>
  <h1 class="visually-hidden">SkillWiki console - Operator login</h1>
  <header>
    <span class="brand">SkillWiki</span>
    <a href="https://github.com/karlorz/llm-wiki">Docs</a>
    <a href="/console">Console</a>
    <a class="active" href="/console/operator-login" aria-current="page">Operator login</a>
  </header>
  <main id="main">
    ${err}
    ${notice}
    ${renderOperatorLoginSection(model.operatorLogin, { dedicated: true })}
  </main>
</body>
</html>
`;
}

function renderOAuthSection(oauth: ConsolePageModel["oauth"]): string {
  if (!oauth) return "";

  const clientsBody =
    oauth.clients.length === 0
      ? `<tr><td colspan="4">No OAuth clients registered.</td></tr>`
      : oauth.clients
          .map((c) => {
            const name = c.clientName || c.clientId;
            const activeGrants = oauth.grants.filter((g) => g.clientId === c.clientId).length;
            return `<tr>
  <td><code class="clip" translate="no" title="${esc(name)}">${esc(name)}</code></td>
  <td class="num">${c.redirectUris.length}</td>
  <td class="num">${activeGrants}</td>
  <td>${revokeClientForm(c, oauth.grants)}</td>
</tr>`;
          })
          .join("\n");

  const grantsBody =
    oauth.grants.length === 0
      ? `<tr><td colspan="5">No active OAuth grants.</td></tr>`
      : oauth.grants
          .map((g) => {
            const expIso = new Date(g.expiresAt).toISOString();
            return `<tr>
  <td><code class="clip" translate="no" title="${esc(g.writerId)}">${esc(g.writerId)}</code></td>
  <td><code translate="no">${esc(fingerprint(g.tokenHash))}</code></td>
  <td>${g.scope ? `<code class="clip" translate="no">${esc(g.scope)}</code>` : ""}</td>
  <td>${timeCell(expIso)}</td>
  <td>${revokeGrantForm(g)}</td>
</tr>`;
          })
          .join("\n");

  return `
    <h2 id="oauth-access">OAuth access</h2>
    <div class="callout">Registered clients and active refresh grants. Revoking a client cascade-revokes all its active grants. Revoking a grant terminates the refresh session.</div>
    <table>
      <thead><tr><th>Registered clients</th><th>Redirect URIs</th><th>Active grants</th><th>Actions</th></tr></thead>
      <tbody>${clientsBody}</tbody>
    </table>

    <table style="margin-top: 1rem;">
      <thead><tr><th>Active grants</th><th>Fingerprint</th><th>Scope</th><th>Expires</th><th>Actions</th></tr></thead>
      <tbody>${grantsBody}</tbody>
    </table>
`;
}

function revokeClientForm(client: ClientEntry, grants: RefreshTokenEntry[]): string {
  const clientGrants = grants.filter((g) => g.clientId === client.clientId);
  const count = clientGrants.length;
  const writerIds = Array.from(new Set(clientGrants.map((g) => g.writerId))).sort();
  const writersStr = writerIds.length > 0 ? writerIds.join(", ") : "none";
  const name = client.clientName || client.clientId;
  const msg = `Revoke client ${name}? This invalidates ${count} active grant(s) for writer(s) ${writersStr}. The connector must re-authorize.`;
  return `<form method="post" action="/console/oauth/revoke-client" onsubmit="return confirm('${esc(msg)}')">
  <input type="hidden" name="client_id" value="${esc(client.clientId)}">
  <input type="hidden" name="confirm" value="1">
  <button type="submit" class="danger" aria-label="Revoke client ${esc(name)}">Revoke client</button>
</form>`;
}

function revokeGrantForm(grant: RefreshTokenEntry): string {
  const fp = fingerprint(grant.tokenHash);
  const msg = `Revoke grant ${fp} for ${grant.writerId}?`;
  return `<form method="post" action="/console/oauth/revoke-grant" onsubmit="return confirm('${esc(msg)}')">
  <input type="hidden" name="token_fingerprint" value="${esc(fp)}">
  <input type="hidden" name="confirm" value="1">
  <button type="submit" class="danger" aria-label="Revoke grant ${esc(fp)}">Revoke grant</button>
</form>`;
}

function revokeForm(hostId: string): string {
  return `<form method="post" action="/console/revoke" onsubmit="return confirm('Revoke ${esc(hostId)}?')">
  <input type="hidden" name="host_id" value="${esc(hostId)}">
  <input type="hidden" name="confirm" value="1">
  <button type="submit" class="danger" aria-label="Revoke ${esc(hostId)}">Revoke</button>
</form>`;
}

export interface ConsoleHandlerOpts {
  tokenMap: TokenMap;
  tokenMapPath?: string;
  auditFile?: string;
  oauth?: OAuthConfig;
  oauthStore?: OAuthStore;
  appendAuditRow?: (row: Omit<AuditRow, "ts">) => void;
}

async function buildModel(
  opts: ConsoleHandlerOpts,
  page: number,
  extra: Partial<ConsolePageModel> = {},
): Promise<ConsolePageModel> {
  const loaded = readAuditLog(opts.auditFile);
  let oauth: ConsolePageModel["oauth"] | undefined;
  if (opts.oauthStore) {
    const [clients, grants] = await Promise.all([
      opts.oauthStore.listClients(),
      opts.oauthStore.listRefreshTokens(),
    ]);
    oauth = { clients, grants };
  }
  const operatorLogin = opts.oauth?.enabled
    ? { configured: Boolean(opts.oauth.passwordHash) }
    : undefined;

  return {
    tokenMap: opts.tokenMap,
    audit: pageAudit(loaded.rows, page),
    devices: devicesFromAudit(loaded.rows, opts.tokenMap),
    oauth,
    operatorLogin,
    ...extra,
    auditError: extra.auditError ?? loaded.error,
  };
}

function html(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function readMapFile(path: string | undefined): string {
  if (!path) return "";
  try {
    return readFileSync(path, "utf8");
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

function persistMap(path: string, yamlText: string, map: TokenMap): void {
  writeFileSync(path, yamlText, { encoding: "utf8", mode: 0o640 });
  replaceTokenMap(map, yamlText);
}

async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

export async function handleConsoleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  opts: ConsoleHandlerOpts,
): Promise<void> {
  const path = url.pathname.replace(/\/$/, "") || "/";
  const page = Number(url.searchParams.get("page") ?? "1");

  if (
    req.method === "GET" &&
    (path === "/console/issue" ||
      path === "/console/revoke" ||
      path === "/console/oauth/revoke-grant" ||
      path === "/console/oauth/revoke-client")
  ) {
    res.writeHead(302, { Location: "/console" });
    res.end();
    return;
  }

  if (req.method === "GET" && path === "/console/oauth/set-password") {
    res.writeHead(302, { Location: "/console/operator-login" });
    res.end();
    return;
  }

  if (req.method === "GET" && (path === "/console/operator-login" || url.pathname === "/console/operator-login/")) {
    html(res, 200, renderOperatorLoginPage(await buildModel(opts, 1)));
    return;
  }

  if (req.method === "GET" && (path === "/console" || url.pathname === "/console/")) {
    html(res, 200, renderConsolePage(await buildModel(opts, page)));
    return;
  }

  if (req.method === "POST" && path === "/console/issue") {
    const form = await readForm(req);
    const hostId = (form.get("host_id") ?? "").trim();
    if (!HOST_ID_RE.test(hostId) || !opts.tokenMapPath) {
      html(res, 400, renderConsolePage(await buildModel(opts, 1, { error: "Invalid host-id." })));
      return;
    }
    const yamlText = readMapFile(opts.tokenMapPath);
    const generated = generateHostBearer();
    const appended = appendHostHash(yamlText, generated.hashHex, hostId);
    if ("error" in appended) {
      html(res, 400, renderConsolePage(await buildModel(opts, 1, { error: ISSUE_ERROR_COPY[appended.error] })));
      return;
    }
    persistMap(opts.tokenMapPath, appended.yaml, opts.tokenMap);
    html(
      res,
      200,
      renderConsolePage(await buildModel(opts, 1, { onceBearer: generated.raw, onceHostId: hostId })),
    );
    return;
  }

  if (req.method === "POST" && path === "/console/revoke") {
    const form = await readForm(req);
    const hostId = (form.get("host_id") ?? "").trim();
    const confirm = form.get("confirm");
    if (confirm !== "1" || !HOST_ID_RE.test(hostId) || !opts.tokenMapPath) {
      html(res, 400, renderConsolePage(await buildModel(opts, 1, { error: "Revoke requires confirmation." })));
      return;
    }
    const yamlText = readMapFile(opts.tokenMapPath);
    const removed = removeHostId(yamlText, hostId);
    if ("error" in removed) {
      html(res, 400, renderConsolePage(await buildModel(opts, 1, { error: "Host-id not found." })));
      return;
    }
    persistMap(opts.tokenMapPath, removed.yaml, opts.tokenMap);
    html(res, 200, renderConsolePage(await buildModel(opts, 1)));
    return;
  }

  if (req.method === "POST" && path === "/console/oauth/revoke-grant") {
    if (!opts.oauthStore) {
      res.writeHead(302, { Location: "/console" });
      res.end();
      return;
    }
    const started = Date.now();
    const form = await readForm(req);
    const tokenHashParam = (form.get("token_hash") ?? "").trim();
    const tokenFpParam = (form.get("token_fingerprint") ?? "").trim();
    const confirm = form.get("confirm");

    if (confirm !== "1" || (!tokenHashParam && !tokenFpParam)) {
      res.writeHead(302, { Location: "/console" });
      res.end();
      return;
    }

    let targetHash = tokenHashParam;
    let fp = tokenFpParam || (tokenHashParam ? fingerprint(tokenHashParam) : "");

    if (!targetHash && tokenFpParam) {
      // Find matching token hash by fingerprint
      const activeGrants = await opts.oauthStore.listRefreshTokens();
      const match = activeGrants.find((g) => fingerprint(g.tokenHash) === tokenFpParam);
      if (match) {
        targetHash = match.tokenHash;
        fp = fingerprint(match.tokenHash);
      }
    }

    const ok = targetHash ? await opts.oauthStore.revokeRefreshToken(targetHash) : false;
    const row: Omit<AuditRow, "ts"> = {
      host_id: "operator",
      tool: "console.oauth_revoke",
      path: `oauth-grant:${fp || "••••????"}`,
      ok,
      ms: Date.now() - started,
    };
    if (opts.appendAuditRow) {
      opts.appendAuditRow(row);
    } else {
      appendAudit(opts.auditFile, row);
    }

    res.writeHead(302, { Location: "/console" });
    res.end();
    return;
  }

  if (req.method === "POST" && path === "/console/oauth/revoke-client") {
    if (!opts.oauthStore) {
      res.writeHead(302, { Location: "/console" });
      res.end();
      return;
    }
    const started = Date.now();
    const form = await readForm(req);
    const clientId = (form.get("client_id") ?? "").trim();
    const confirm = form.get("confirm");

    if (confirm !== "1" || !clientId) {
      res.writeHead(302, { Location: "/console" });
      res.end();
      return;
    }

    // Check if client exists to determine ok
    const existing = await opts.oauthStore.getClient(clientId);
    const ok = existing !== null;
    if (ok) {
      await opts.oauthStore.revokeClient(clientId);
    }

    const row: Omit<AuditRow, "ts"> = {
      host_id: "operator",
      tool: "console.oauth_revoke",
      path: `oauth-client:${clientId}`,
      ok,
      ms: Date.now() - started,
    };
    if (opts.appendAuditRow) {
      opts.appendAuditRow(row);
    } else {
      appendAudit(opts.auditFile, row);
    }

    res.writeHead(302, { Location: "/console" });
    res.end();
    return;
  }

  if (req.method === "POST" && path === "/console/oauth/set-password") {
    const started = Date.now();
    const form = await readForm(req);
    const password = form.get("password") ?? "";
    const passwordConfirm = form.get("password_confirm") ?? "";
    const confirm = form.get("confirm");

    const isWhitespaceOnly = password.length > 0 && password.trim().length === 0;
    const isValid =
      opts.oauth !== undefined &&
      opts.oauth.stateDir !== undefined &&
      password.length > 0 &&
      !isWhitespaceOnly &&
      password === passwordConfirm &&
      confirm === "1";

    if (!isValid || !opts.oauth || !opts.oauth.stateDir) {
      const errorMsg =
        opts.oauth?.stateDir === undefined
          ? "State directory not configured."
          : password.length === 0 || isWhitespaceOnly
            ? "Password cannot be empty."
            : password !== passwordConfirm
              ? "Passwords do not match."
              : "Confirmation required.";

      html(res, 400, renderOperatorLoginPage(await buildModel(opts, 1, { error: errorMsg })));
      return;
    }

    const stateDir = opts.oauth.stateDir;
    const oauthConfig = opts.oauth;
    const encodedHash = hashPassword(password);
    try {
      writePasswordHashFile(stateDir, encodedHash);
    } catch (err: unknown) {
      html(res, 500, renderOperatorLoginPage(await buildModel(opts, 1, { error: "Failed to persist password hash." })));
      return;
    }

    oauthConfig.passwordHash = encodedHash;

    const row: Omit<AuditRow, "ts"> = {
      host_id: "operator",
      tool: "console.oauth_set_password",
      path: "oauth-operator-login",
      ok: true,
      ms: Date.now() - started,
    };
    if (opts.appendAuditRow) {
      opts.appendAuditRow(row);
    } else {
      appendAudit(opts.auditFile, row);
    }

    html(res, 200, renderOperatorLoginPage(await buildModel(opts, 1, { notice: "Password set." })));
    return;
  }

  html(res, 404, renderConsolePage(await buildModel(opts, 1, { error: "Not found." })));
}
