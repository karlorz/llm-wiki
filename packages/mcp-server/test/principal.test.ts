import { describe, expect, it } from "vitest";
import { authorizeVaultSelection, handshakeFor, normalizeGrants } from "../src/principal.js";
import { buildVaultRegistry } from "../src/vault-registry.js";

function registry(enabledExtra = true) {
  return buildVaultRegistry([
    {
      vaultId: "central",
      isDefault: true,
      localRoot: "/tmp/skillwiki-central-a",
      rcloneRemote: "seaweed-wiki",
      rclonePath: "cloud/wiki",
      s3Bucket: "cloud",
      s3Prefix: "wiki",
    },
    {
      vaultId: "wiki-fin",
      enabled: enabledExtra,
      localRoot: "/tmp/skillwiki-fin-a",
      rcloneRemote: "seaweed-wiki",
      rclonePath: "cloud/wiki-fin",
      s3Bucket: "cloud",
      s3Prefix: "wiki-fin",
    },
  ]);
}

describe("principal authorization", () => {
  it("omitted grants resolve only to the default vault", () => {
    const reg = registry();
    const principal = normalizeGrants("macos-dev", undefined, reg);
    expect(principal.allowedVaults).toEqual(["central"]);
    expect(authorizeVaultSelection({ requested: undefined, principal, registry: reg })).toEqual({
      ok: true,
      vaultId: "central",
    });
  });

  it("rejects wildcards by granting nothing", () => {
    const reg = registry();
    const principal = normalizeGrants("macos-dev", ["*"], reg);
    expect(principal.allowedVaults).toEqual([]);
    expect(authorizeVaultSelection({ requested: undefined, principal, registry: reg }).ok).toBe(false);
  });

  it("fails closed for unknown, unauthorized, disabled, and malformed ids", () => {
    const reg = registry(false);
    const principal = normalizeGrants("macos-dev", ["central", "wiki-fin"], reg);
    expect(authorizeVaultSelection({ requested: "no-such", principal, registry: reg })).toMatchObject({
      error: "VAULT_UNKNOWN",
    });
    const centralOnly = normalizeGrants("macos-dev", ["central"], reg);
    expect(authorizeVaultSelection({ requested: "wiki-fin", principal: centralOnly, registry: reg })).toMatchObject({
      error: "VAULT_UNAUTHORIZED",
    });
    expect(authorizeVaultSelection({ requested: "wiki-fin", principal, registry: reg })).toMatchObject({
      error: "VAULT_DISABLED",
    });
    expect(authorizeVaultSelection({ requested: "Central", principal, registry: reg })).toMatchObject({
      error: "VAULT_MALFORMED",
    });
  });

  it("handshake advertises only enabled allowed vaults from server state", () => {
    const reg = registry(false);
    const principal = normalizeGrants("macos-dev", ["central", "wiki-fin"], reg);
    expect(handshakeFor(principal, reg)).toEqual({
      default_vault: "central",
      allowed_vaults: ["central"],
    });
  });
});
