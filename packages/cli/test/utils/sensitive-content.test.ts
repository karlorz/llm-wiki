import { describe, expect, it } from "vitest";
import { redactSensitiveContent, scanSensitiveContent } from "../../src/utils/sensitive-content.js";

function generatedAccessKey(): string {
  return "hana_" + "dev_" + "A".repeat(43);
}

function generatedBearer(): string {
  return "Bearer " + "B".repeat(48);
}

describe("sensitive-content", () => {
  it("detects a labeled access key without returning the raw value", () => {
    const secret = generatedAccessKey();
    const text = `Access key: ${secret}\n`;

    const findings = scanSensitiveContent(text, { file: "queries/example.md" });

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      file: "queries/example.md",
      line: 1,
      kind: "access_key",
    });
    expect(findings[0]!.preview).toContain("[REDACTED:access_key:");
    expect(JSON.stringify(findings)).not.toContain(secret);
  });

  it("detects authorization bearer values", () => {
    const secret = generatedBearer();
    const findings = scanSensitiveContent(`Authorization: ${secret}\n`);

    expect(findings.map(f => f.kind)).toContain("authorization_header");
    expect(JSON.stringify(findings)).not.toContain(secret);
  });

  it("detects quoted config values", () => {
    const password = "dev-only-" + "P".repeat(24);
    const apiKey = "key_" + "K".repeat(28);
    const text = [
      `"password": "${password}",`,
      `api_key: '${apiKey}'`,
    ].join("\n");

    const findings = scanSensitiveContent(text);

    expect(findings.map(f => f.kind)).toEqual(["password", "api_key"]);
    expect(JSON.stringify(findings)).not.toContain(password);
    expect(JSON.stringify(findings)).not.toContain(apiKey);
  });

  it("detects common provider key prefixes", () => {
    const openAiLike = "sk-" + "A".repeat(48);
    const slackLike = "xoxb-" + "B".repeat(48);

    const findings = scanSensitiveContent(`${openAiLike}\n${slackLike}\n`);

    expect(findings.map(f => f.kind)).toEqual(["provider_key", "provider_key"]);
    expect(JSON.stringify(findings)).not.toContain(openAiLike);
    expect(JSON.stringify(findings)).not.toContain(slackLike);
  });

  it("detects private key blocks", () => {
    const text = [
      "-----BEGIN OPENSSH PRIVATE KEY-----",
      "not-a-real-key-fixture",
      "-----END OPENSSH PRIVATE KEY-----",
    ].join("\n");

    const findings = scanSensitiveContent(text);

    expect(findings.map(f => f.kind)).toContain("private_key");
  });

  it("ignores redacted placeholders and ordinary hashes", () => {
    const text = [
      "Access key: [REDACTED:access_key:abc123]",
      "sha256: " + "a".repeat(64),
      "The password field is required but no value is stored.",
    ].join("\n");

    expect(scanSensitiveContent(text)).toEqual([]);
  });

  it("ignores session prose and session-scheme URLs (token matcher false positives)", () => {
    // Structural shapes of the 2026-07-26 vault findings — do not quote live vault text.
    const proseNote = "Prior this session: incidents-isolated\n";
    const sessionSchemeUrl = "source_url: session://example-project-v1.2.3-sync-run\n";
    const pytestScope = "session: session-scoped-root\n";

    expect(scanSensitiveContent(proseNote)).toEqual([]);
    expect(scanSensitiveContent(sessionSchemeUrl)).toEqual([]);
    expect(scanSensitiveContent(pytestScope)).toEqual([]);
  });

  it("still detects credential-shaped session and token assignments", () => {
    const sessionSecret = "Sess" + "0".repeat(12) + "AbCdEf";
    const tokenSecret = "tok_" + "A1b2".repeat(8);

    // Scan separately so adjacent-line preview windows cannot leak the peer secret.
    const sessionFindings = scanSensitiveContent(`session: ${sessionSecret}\n`);
    const tokenFindings = scanSensitiveContent(`token: ${tokenSecret}\n`);

    expect(sessionFindings).toHaveLength(1);
    expect(sessionFindings[0]!.kind).toBe("token");
    expect(sessionFindings[0]!.preview).toContain("[REDACTED:token:");
    expect(JSON.stringify(sessionFindings)).not.toContain(sessionSecret);

    expect(tokenFindings).toHaveLength(1);
    expect(tokenFindings[0]!.kind).toBe("token");
    expect(tokenFindings[0]!.preview).toContain("[REDACTED:token:");
    expect(JSON.stringify(tokenFindings)).not.toContain(tokenSecret);
  });

  it("redacts values and keeps findings redacted", () => {
    const secret = generatedAccessKey();
    const result = redactSensitiveContent(`Access key: ${secret}\n`);

    expect(result.changed).toBe(true);
    expect(result.text).toContain("Access key: [REDACTED:access_key:");
    expect(result.text).not.toContain(secret);
    expect(JSON.stringify(result.findings)).not.toContain(secret);
  });

  describe("token matcher precision (G1/G2)", () => {
    it("ignores pure lower-hyphen prose after bare session: (FP1 shape)", () => {
      const text = "Prior this session: incidents-isolate session-scoped root\n";
      expect(scanSensitiveContent(text)).toEqual([]);
    });

    it("ignores session:// URL scheme captures (FP2 shape)", () => {
      const text = "source_url: session://abc123def456ghi789xyz\n";
      expect(scanSensitiveContent(text)).toEqual([]);
    });

    it("ignores additional pure lower-hyphen session prose", () => {
      const text = "this session: another-long-hyphenated-phrase\n";
      expect(scanSensitiveContent(text)).toEqual([]);
    });

    it("still detects explicit token assignments", () => {
      const secret = "abcdefghijklmnop"; // length 16, not pure lower-hyphen compound
      const findings = scanSensitiveContent(`token: ${secret}\n`);
      expect(findings).toHaveLength(1);
      expect(findings[0]).toMatchObject({ kind: "token", line: 1 });
      expect(findings[0]!.preview).toContain("[REDACTED:token:");
      expect(JSON.stringify(findings)).not.toContain(secret);
    });

    it("still detects mixed-shape token values", () => {
      const secret = "tok_aB3dEf9hIjKlMnOpQrStUv";
      const findings = scanSensitiveContent(`token: ${secret}\n`);
      expect(findings.map(f => f.kind)).toContain("token");
      expect(JSON.stringify(findings)).not.toContain(secret);
    });

    it("does not redact FP prose via redactSensitiveContent", () => {
      const text = "Prior this session: incidents-isolate session-scoped root\n";
      const result = redactSensitiveContent(text);
      expect(result.changed).toBe(false);
      expect(result.text).toBe(text);
      expect(result.findings).toEqual([]);
    });
  });

  describe("2026-08-09 regression fixtures (structural shapes)", () => {
    it("ignores the English noun 'pass' with a colon and a bolded verdict (password FP)", () => {
      const text = "- Decision for this pass: **KEEP** every OID as audit backlog\n";
      expect(scanSensitiveContent(text)).toEqual([]);
      const result = redactSensitiveContent(text);
      expect(result.changed).toBe(false);
    });

    it("still detects password and passwd labels (regression)", () => {
      const secret = "dev-only-" + "A".repeat(16);
      const passwordFindings = scanSensitiveContent(`password: ${secret}\n`);
      const passwdFindings = scanSensitiveContent(`passwd: ${secret}\n`);
      expect(passwordFindings.map(f => f.kind)).toEqual(["password"]);
      expect(passwdFindings.map(f => f.kind)).toEqual(["password"]);
      expect(JSON.stringify([...passwordFindings, ...passwdFindings])).not.toContain(secret);
    });

    it("ignores dotted/alphanumeric model names after Session: (token FP)", () => {
      const text = "# Session: gpt-5.6-luna-max encrypted thinking content blocks\n";
      expect(scanSensitiveContent(text)).toEqual([]);
      const result = redactSensitiveContent(text);
      expect(result.changed).toBe(false);
    });

    it("still captures sess_ session identifiers (policy: conservative)", () => {
      const text = "session: sess_0msegsr5x_3a6d6110a72a2f16d492\n";
      const findings = scanSensitiveContent(text);
      expect(findings).toHaveLength(1);
      expect(findings[0]!.kind).toBe("token");
      expect(findings[0]!.preview).toContain("[REDACTED:token:");
      expect(JSON.stringify(findings)).not.toContain("sess_0msegsr5x_3a6d6110a72a2f16d492");
    });

    it("still captures pure-hex hyphenated session UUIDs (policy: conservative)", () => {
      const text = "Parent session: 019fda67-1858-7851-aad6-fb7ef06e4d96 (grok-4.5)\n";
      const findings = scanSensitiveContent(text);
      expect(findings).toHaveLength(1);
      expect(findings[0]!.kind).toBe("token");
      expect(findings[0]!.preview).toContain("[REDACTED:token:");
      expect(JSON.stringify(findings)).not.toContain("019fda67-1858-7851-aad6-fb7ef06e4d96");
    });

    it("still captures mixed-case hyphenated values that are not model-name shaped", () => {
      const secret = "A1b2-C3d4-E5f6-G7h8-I9j0K1l2";
      const findings = scanSensitiveContent(`session: ${secret}\n`);
      expect(findings).toHaveLength(1);
      expect(findings[0]!.kind).toBe("token");
      expect(JSON.stringify(findings)).not.toContain(secret);
    });

    it("ignores vault-relative paths after Session: and token: labels (path FP)", () => {
      const transcriptLine = "- Session: raw/transcripts/2026-08-19-session-log-cursor-claude-mcp-migration-resume.md\n";
      const projectLine = "Session: projects/llm-wiki/history/specs/2026-05-02-llm-wiki-skill-design.md\n";
      const tokenPath = "token: path/to/some/subfolder/file.md\n";

      expect(scanSensitiveContent(transcriptLine)).toEqual([]);
      expect(scanSensitiveContent(projectLine)).toEqual([]);
      expect(scanSensitiveContent(tokenPath)).toEqual([]);

      const transcriptRedact = redactSensitiveContent(transcriptLine);
      expect(transcriptRedact.changed).toBe(false);
      expect(transcriptRedact.text).toBe(transcriptLine);
    });
  });
});
