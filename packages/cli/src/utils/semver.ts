/**
 * Minimal semver comparison for skillwiki version strings.
 * Handles format: "0.2.0-beta.15" (major.minor.patch[-prerelease]).
 *
 * Returns true if `a` is strictly greater than `b`.
 */
export function semverGt(a: string, b: string): boolean {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return a > b; // fallback to string compare if unparseable

  // Compare major.minor.patch numerically
  if (pa.major !== pb.major) return pa.major > pb.major;
  if (pa.minor !== pb.minor) return pa.minor > pb.minor;
  if (pa.patch !== pb.patch) return pa.patch > pb.patch;

  // Same base version — pre-release ordering:
  // "no pre-release" > "has pre-release" (e.g. 1.0.0 > 1.0.0-beta.1)
  if (!pa.pre && pb.pre) return true;
  if (pa.pre && !pb.pre) return false;
  if (!pa.pre && !pb.pre) return false; // equal

  // Both have pre-release: split on ".", compare numerically where possible
  const aParts = pa.pre!.split(".");
  const bParts = pb.pre!.split(".");
  const len = Math.max(aParts.length, bParts.length);
  for (let i = 0; i < len; i++) {
    const ai = aParts[i];
    const bi = bParts[i];
    if (ai === undefined) return false; // shorter pre-release is less
    if (bi === undefined) return true;
    const aNum = parseInt(ai, 10);
    const bNum = parseInt(bi, 10);
    if (!isNaN(aNum) && !isNaN(bNum)) {
      if (aNum !== bNum) return aNum > bNum;
    } else {
      if (ai !== bi) return ai > bi;
    }
  }
  return false; // equal
}

interface SemverParts {
  major: number;
  minor: number;
  patch: number;
  pre: string | null;
}

function parseSemver(version: string): SemverParts | null {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/);
  if (!match) return null;
  return {
    major: parseInt(match[1], 10),
    minor: parseInt(match[2], 10),
    patch: parseInt(match[3], 10),
    pre: match[4] ?? null,
  };
}
