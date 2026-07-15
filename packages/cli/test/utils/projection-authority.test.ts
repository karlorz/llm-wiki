import { describe, expect, it } from "vitest";
import { resolveProjectionAuthority } from "../../src/utils/projection-authority.js";

describe("resolveProjectionAuthority", () => {
  it("treats missing fleet as standalone writer", () => {
    expect(resolveProjectionAuthority(null)).toMatchObject({
      ok: true,
      data: { authority_host_id: "standalone", can_write: true },
    });
  });

  it("derives sole snapshotter and gates write", () => {
    const load = {
      manifest: {
        schema_version: 1 as const,
        vault_remote: "o/w",
        hosts: {
          sg01: { class: "prod-linux", role: "snapshotter", writes_to: ["github"] },
          leaf: { class: "dev-macos", role: "leaf", writes_to: ["github"] },
        },
      },
      hostId: "leaf",
      source: "test",
      warnings: [],
      identityStatus: "known" as const,
    };
    // @ts-expect-error partial host schema for unit test
    expect(resolveProjectionAuthority(load)).toMatchObject({
      ok: true,
      data: { authority_host_id: "sg01", can_write: false },
    });
    // @ts-expect-error partial host schema for unit test
    expect(resolveProjectionAuthority({ ...load, hostId: "sg01" })).toMatchObject({
      ok: true,
      data: { can_write: true },
    });
  });
});
