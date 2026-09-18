import { describe, expect, it } from "vitest";
import {
  parseSkillwikiExtraVaults,
  selectableVaults,
  SKILLWIKI_EXTRA_VAULTS_FIELD,
  SKILLWIKI_MCP_TOKEN_FIELD,
} from "../src/extra-vaults.js";

describe("SKILLWIKI_EXTRA_VAULTS client opt-in", () => {
  it("is a distinct non-secret field from SKILLWIKI_MCP_TOKEN", () => {
    expect(SKILLWIKI_EXTRA_VAULTS_FIELD).toBe("SKILLWIKI_EXTRA_VAULTS");
    expect(SKILLWIKI_MCP_TOKEN_FIELD).toBe("SKILLWIKI_MCP_TOKEN");
    expect(SKILLWIKI_EXTRA_VAULTS_FIELD).not.toBe(SKILLWIKI_MCP_TOKEN_FIELD);
  });

  it("parses empty as default-only", () => {
    expect(parseSkillwikiExtraVaults(undefined)).toEqual({ ok: true, vaults: [] });
    expect(parseSkillwikiExtraVaults("")).toEqual({ ok: true, vaults: [] });
    expect(parseSkillwikiExtraVaults("  ")).toEqual({ ok: true, vaults: [] });
  });

  it("parses comma or whitespace lists without secrets", () => {
    expect(parseSkillwikiExtraVaults("wiki-fin")).toEqual({ ok: true, vaults: ["wiki-fin"] });
    expect(parseSkillwikiExtraVaults("wiki-fin, research")).toEqual({ ok: true, vaults: ["wiki-fin", "research"] });
    expect(parseSkillwikiExtraVaults("wiki-fin wiki-fin")).toEqual({ ok: true, vaults: ["wiki-fin"] });
  });

  it("fails closed on wildcards and malformed ids", () => {
    expect(parseSkillwikiExtraVaults("*")).toMatchObject({ ok: false, error: "WILDCARD" });
    expect(parseSkillwikiExtraVaults("wiki-*")).toMatchObject({ ok: false, error: "WILDCARD" });
    expect(parseSkillwikiExtraVaults("cloud/wiki")).toMatchObject({ ok: false, error: "MALFORMED" });
    expect(parseSkillwikiExtraVaults("Central")).toMatchObject({ ok: false, error: "MALFORMED" });
  });

  it("intersects client opt-in with server allowed_vaults; default stays available", () => {
    expect(
      selectableVaults({
        extraVaults: [],
        allowedVaults: ["central", "wiki-fin"],
        defaultVault: "central",
      }),
    ).toEqual(["central"]);
    expect(
      selectableVaults({
        extraVaults: ["wiki-fin"],
        allowedVaults: ["central", "wiki-fin"],
        defaultVault: "central",
      }),
    ).toEqual(["central", "wiki-fin"]);
    expect(
      selectableVaults({
        extraVaults: ["wiki-fin"],
        allowedVaults: ["central"],
        defaultVault: "central",
      }),
    ).toEqual(["central"]);
  });
});
