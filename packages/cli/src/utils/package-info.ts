import { readFileSync } from "node:fs";

export interface CliPackageInfo {
  name?: string;
  version: string;
}

export function packageJsonCandidateUrls(baseUrl: string = import.meta.url): URL[] {
  return [
    new URL("../package.json", baseUrl),
    new URL("../../package.json", baseUrl),
  ];
}

export function readCliPackageJson(baseUrl: string = import.meta.url): CliPackageInfo {
  for (const url of packageJsonCandidateUrls(baseUrl)) {
    try {
      const pkg = JSON.parse(readFileSync(url, "utf8")) as Partial<CliPackageInfo>;
      if (typeof pkg.version === "string") {
        return { ...pkg, version: pkg.version };
      }
    } catch {
      // Try the next source/dist layout candidate.
    }
  }
  throw new Error(`Could not locate skillwiki package.json from ${baseUrl}`);
}
