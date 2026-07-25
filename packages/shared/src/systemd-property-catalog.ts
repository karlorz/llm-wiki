import catalog from "./systemd-property-catalog.json";

/**
 * Canonical semantic health field → case-sensitive systemd property catalog.
 *
 * Shell consumers use a generated adapter derived from the adjacent JSON file.
 * Unknown semantic keys intentionally resolve to undefined so fixture-style
 * snake_case names can never leak into live `systemctl show` requests.
 */
export const SYSTEMD_PROPERTY_CATALOG: Readonly<Record<string, string>> =
  Object.freeze({ ...catalog });

export function systemdPropertyFor(semantic: string): string | undefined {
  return SYSTEMD_PROPERTY_CATALOG[semantic];
}
