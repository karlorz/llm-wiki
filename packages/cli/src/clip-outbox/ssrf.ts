import { isIP } from "node:net";
import { lookup as dnsLookup } from "node:dns/promises";
import { ipv4InCidr, isBlockedHost } from "@skillwiki/shared";
import { runFetchGuardSync } from "../commands/fetch-guard.js";

export type LookupFn = (hostname: string) => Promise<string[]>;

const extraBlockedV4 = [
  ["0.0.0.0", 8],
  ["100.64.0.0", 10],
  ["192.0.2.0", 24],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const;

export function isBlockedAddress(address: string): boolean {
  if (isBlockedHost(address)) return true;
  const version = isIP(address);
  if (version === 4) {
    return extraBlockedV4.some(([base, prefix]) => ipv4InCidr(address, base, prefix));
  }
  if (version === 6) {
    const lower = address.toLowerCase();
    return lower === "::" || lower === "::1" || lower.startsWith("fc") || lower.startsWith("fd") || lower.startsWith("fe80:");
  }
  return false;
}

export async function assertPublicHttpsUrl(
  url: string,
  lookup: LookupFn = defaultLookup,
): Promise<{ ok: true; href: string } | { ok: false; reason: string }> {
  const guard = runFetchGuardSync({ url });
  if (!guard.result.ok) {
    return { ok: false, reason: guard.result.error };
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: "MALFORMED_URL" };
  }
  if (isBlockedAddress(parsed.hostname)) {
    return { ok: false, reason: "HOST_BLOCKED" };
  }
  try {
    const addresses = await lookup(parsed.hostname);
    if (addresses.length === 0) return { ok: false, reason: "DNS_EMPTY" };
    if (addresses.some(isBlockedAddress)) return { ok: false, reason: "HOST_BLOCKED" };
  } catch {
    return { ok: false, reason: "DNS_FAILED" };
  }
  return { ok: true, href: parsed.href };
}

async function defaultLookup(hostname: string): Promise<string[]> {
  if (isIP(hostname)) return [hostname];
  const v4 = await dnsLookup(hostname, { all: true, verbatim: true });
  return v4.map((row) => row.address);
}
