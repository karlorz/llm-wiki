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

  it("redacts values and keeps findings redacted", () => {
    const secret = generatedAccessKey();
    const result = redactSensitiveContent(`Access key: ${secret}\n`);

    expect(result.changed).toBe(true);
    expect(result.text).toContain("Access key: [REDACTED:access_key:");
    expect(result.text).not.toContain(secret);
    expect(JSON.stringify(result.findings)).not.toContain(secret);
  });
});
