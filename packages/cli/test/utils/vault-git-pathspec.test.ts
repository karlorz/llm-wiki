import { describe, it, expect } from "vitest";
import {
  VAULT_GENERATED_COMMIT_PATHS,
  VAULT_GENERATED_COMMIT_EXCLUDES,
  VAULT_COMMIT_PATHSPEC,
} from "../../src/utils/vault-git-pathspec.js";

describe("vault-git-pathspec constants", () => {
  it("excludes mirror generated paths with pathspec negation", () => {
    expect(VAULT_GENERATED_COMMIT_EXCLUDES).toHaveLength(VAULT_GENERATED_COMMIT_PATHS.length);
    for (const p of VAULT_GENERATED_COMMIT_PATHS) {
      expect(VAULT_GENERATED_COMMIT_EXCLUDES).toContain(`:!${p}`);
    }
  });

  it("commit pathspec stages repo root minus generated excludes", () => {
    expect(VAULT_COMMIT_PATHSPEC[0]).toBe(".");
    expect(VAULT_COMMIT_PATHSPEC.slice(1)).toEqual(VAULT_GENERATED_COMMIT_EXCLUDES);
  });
});