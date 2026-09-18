import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildVaultRegistry,
  namespacesOverlap,
  rcloneAndS3Agree,
  resolveVaultS3AdapterTarget,
  singletonVaultInput,
  VaultRegistryError,
} from "../src/vault-registry.js";

function entry(overrides: Partial<Parameters<typeof singletonVaultInput>[0]> & { vaultId: string; isDefault?: boolean; enabled?: boolean }) {
  return {
    vaultId: overrides.vaultId,
    isDefault: overrides.isDefault ?? false,
    enabled: overrides.enabled ?? true,
    localRoot: overrides.localRoot ?? `/tmp/skillwiki-${overrides.vaultId}`,
    rcloneRemote: overrides.rcloneRemote ?? "seaweed-wiki",
    rclonePath: overrides.rclonePath ?? `cloud/${overrides.vaultId}`,
    s3Bucket: overrides.s3Bucket ?? "cloud",
    s3Prefix: overrides.s3Prefix ?? overrides.vaultId,
    s3Endpoint: overrides.s3Endpoint ?? "http://127.0.0.1:8333",
  };
}

describe("vault registry validation", () => {
  it("accepts central plus a non-overlapping extra vault", async () => {
    const root = await mkdtemp(join(tmpdir(), "reg-"));
    const extra = await mkdtemp(join(tmpdir(), "reg-extra-"));
    const registry = buildVaultRegistry([
      entry({ vaultId: "central", isDefault: true, localRoot: root, rclonePath: "cloud/wiki", s3Prefix: "wiki" }),
      entry({ vaultId: "wiki-fin", localRoot: extra, rclonePath: "cloud/wiki-fin", s3Prefix: "wiki-fin" }),
    ]);
    expect(registry.defaultVaultId).toBe("central");
    expect(registry.entries.size).toBe(2);
  });

  it("rejects duplicate vault ids", () => {
    expect(() =>
      buildVaultRegistry([
        entry({ vaultId: "central", isDefault: true }),
        entry({ vaultId: "central" }),
      ]),
    ).toThrow(VaultRegistryError);
    try {
      buildVaultRegistry([entry({ vaultId: "central", isDefault: true }), entry({ vaultId: "central" })]);
    } catch (error) {
      expect((error as VaultRegistryError).code).toBe("DUPLICATE_VAULT_ID");
    }
  });

  it("rejects duplicate defaults", () => {
    expect(() =>
      buildVaultRegistry([
        entry({ vaultId: "central", isDefault: true }),
        entry({ vaultId: "wiki-fin", isDefault: true, rclonePath: "cloud/wiki-fin", s3Prefix: "wiki-fin" }),
      ]),
    ).toThrow(/duplicate default/);
  });

  it("rejects overlapping prefixes and nested prefixes", () => {
    expect(namespacesOverlap("cloud/wiki", "cloud/wiki")).toBe(true);
    expect(namespacesOverlap("cloud/wiki", "cloud/wiki/fin")).toBe(true);
    expect(namespacesOverlap("cloud/wiki-fin", "cloud/wiki")).toBe(false);
    expect(() =>
      buildVaultRegistry([
        entry({ vaultId: "central", isDefault: true, rclonePath: "cloud/wiki", s3Prefix: "wiki" }),
        entry({ vaultId: "wiki-fin", rclonePath: "cloud/wiki/fin", s3Prefix: "wiki/fin" }),
      ]),
    ).toThrow(/overlap/);
  });

  it("rejects overlapping local roots", async () => {
    const root = await mkdtemp(join(tmpdir(), "reg-root-"));
    expect(() =>
      buildVaultRegistry([
        entry({ vaultId: "central", isDefault: true, localRoot: root, rclonePath: "cloud/wiki", s3Prefix: "wiki" }),
        entry({ vaultId: "wiki-fin", localRoot: root, rclonePath: "cloud/wiki-fin", s3Prefix: "wiki-fin" }),
      ]),
    ).toThrow(/local roots overlap/);
  });

  it("rejects parent-segment traversal in local_root", () => {
    expect(() =>
      buildVaultRegistry([
        entry({ vaultId: "central", isDefault: true, localRoot: "/tmp/skillwiki-central/../evil" }),
      ]),
    ).toThrow(/traverses parent/);
  });

  it("rejects malformed vault ids including wildcards", () => {
    expect(() => buildVaultRegistry([entry({ vaultId: "Central", isDefault: true })])).toThrow(/malformed/);
    expect(() => buildVaultRegistry([entry({ vaultId: "wiki/*", isDefault: true })])).toThrow();
    expect(() => buildVaultRegistry([entry({ vaultId: "", isDefault: true })])).toThrow();
  });

  it("rejects rclone vs direct-S3 namespace mismatch", () => {
    expect(rcloneAndS3Agree({ rclonePath: "cloud/wiki", s3Bucket: "cloud", s3Prefix: "wiki" })).toBe(true);
    expect(rcloneAndS3Agree({ rclonePath: "cloud/wiki", s3Bucket: "cloud/wiki" })).toBe(true);
    expect(rcloneAndS3Agree({ rclonePath: "cloud/wiki", s3Bucket: "cloud", s3Prefix: "wiki-fin" })).toBe(false);
    expect(() =>
      buildVaultRegistry([
        entry({
          vaultId: "central",
          isDefault: true,
          rclonePath: "cloud/wiki",
          s3Bucket: "cloud",
          s3Prefix: "other",
        }),
      ]),
    ).toThrow(/does not match S3/);
  });

  it("rejects a disabled default vault", () => {
    expect(() =>
      buildVaultRegistry([entry({ vaultId: "central", isDefault: true, enabled: false })]),
    ).toThrow(/cannot be disabled/);
  });

  it("requires extra vaults to declare an explicit S3 bucket and prefix", () => {
    expect(() =>
      buildVaultRegistry([
        entry({ vaultId: "central", isDefault: true, rclonePath: "cloud/wiki", s3Prefix: "wiki" }),
        {
          vaultId: "wiki-fin",
          localRoot: "/tmp/skillwiki-wiki-fin-ns",
          rcloneRemote: "seaweed-wiki",
          rclonePath: "cloud/wiki-fin",
        },
      ]),
    ).toThrow(/explicit s3.bucket and s3.prefix/);
    try {
      buildVaultRegistry([
        entry({ vaultId: "central", isDefault: true, rclonePath: "cloud/wiki", s3Prefix: "wiki" }),
        {
          vaultId: "wiki-fin",
          localRoot: "/tmp/skillwiki-wiki-fin-ns",
          rcloneRemote: "seaweed-wiki",
          rclonePath: "cloud/wiki-fin",
        },
      ]);
    } catch (error) {
      expect((error as VaultRegistryError).code).toBe("EXTRA_S3_NAMESPACE_REQUIRED");
    }
  });

  it("preserves the existing central namespace when a check is supplied", async () => {
    const root = await mkdtemp(join(tmpdir(), "reg-central-"));
    expect(() =>
      buildVaultRegistry(
        [entry({ vaultId: "central", isDefault: true, localRoot: `${root}-moved`, rclonePath: "cloud/wiki", s3Prefix: "wiki" })],
        {
          central: {
            localRoot: root,
            rcloneRemote: "seaweed-wiki",
            rclonePath: "cloud/wiki",
            s3Bucket: "cloud",
            s3Prefix: "wiki",
          },
        },
      ),
    ).toThrow(/retain the existing central/);
  });

  it("does not let an extra vault inherit the central S3 prefix", () => {
    const extra = entry({ vaultId: "wiki-fin", rclonePath: "cloud/wiki-fin", s3Prefix: "wiki-fin" });
    extra.isDefault = false;
    const resolved = buildVaultRegistry([
      entry({ vaultId: "central", isDefault: true, rclonePath: "cloud/wiki", s3Prefix: "wiki" }),
      extra,
    ]).entries.get("wiki-fin")!;
    const target = resolveVaultS3AdapterTarget(resolved, { s3Bucket: "cloud", s3Prefix: "wiki" });
    expect(target).toEqual({ bucket: "cloud", prefix: "wiki-fin", endpoint: extra.s3Endpoint });
    expect("prefix" in target && target.prefix).not.toBe("wiki");
  });
});
