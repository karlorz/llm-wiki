export const METADATA_HOSTS = [
  "metadata.google.internal",
  "metadata"
] as const;

const METADATA_IPS = new Set(["169.254.169.254"]);

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    const v = Number(p);
    if (!Number.isInteger(v) || v < 0 || v > 255) return null;
    n = (n << 8) + v;
  }
  return n >>> 0;
}

function inRange(ip: string, baseStr: string, prefix: number): boolean {
  const ipN = ipv4ToInt(ip);
  const baseN = ipv4ToInt(baseStr);
  if (ipN === null || baseN === null) return false;
  const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
  return (ipN & mask) === (baseN & mask);
}

export function isBlockedHost(host: string): boolean {
  const lower = host.toLowerCase();
  if (METADATA_HOSTS.includes(lower as any)) return true;
  if (METADATA_IPS.has(host)) return true;

  // IPv6 quick checks
  if (lower === "::1") return true;
  if (lower.startsWith("fe80:")) return true;

  // IPv4 ranges
  if (ipv4ToInt(host) === null) return false;
  if (inRange(host, "10.0.0.0", 8)) return true;
  if (inRange(host, "172.16.0.0", 12)) return true;
  if (inRange(host, "192.168.0.0", 16)) return true;
  if (inRange(host, "169.254.0.0", 16)) return true;
  if (inRange(host, "127.0.0.0", 8)) return true;
  return false;
}
