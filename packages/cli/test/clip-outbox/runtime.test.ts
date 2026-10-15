import { describe, expect, it } from "vitest";
import { appendFile, chmod, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadClipCredentials, conditionalCreateProven } from "../../src/clip-outbox/runtime.js";
import { clipFixture } from "./fixture.js";

const fixtureS3 = { endpoint: "https://storage.example.com", accessKeyId: "fixture-access", secretAccessKey: "fixture-secret" };
describe("protected file channel providers", () => {
  it("rejects an MCP token saved only in host dotenv and never includes values in errors", async () => {
    const { home, config } = await clipFixture();
    await appendFile(join(home, ".skillwiki/.env"), "\nSKILLWIKI_MCP_TOKEN=fixture-mcp-only\n");
    await writeFile(join(home, ".skillwiki/clip-outbox-credentials.json"), JSON.stringify({ CLIP_S3: fixtureS3, CLIP_READY: "fixture-mcp-only" }), { mode: 0o600 });
    await expect(loadClipCredentials(home, config, {})).rejects.toThrow(/separate file-ingress token/);
    await expect(loadClipCredentials(home, config, {})).rejects.not.toThrow(/fixture-mcp-only/);
    await rm(home, { recursive: true });
  });
  it("requires private provider file permissions and destination-bound evidence", async () => {
    const { home, config } = await clipFixture();
    const path = join(home, ".skillwiki/clip-outbox-credentials.json");
    await writeFile(path, JSON.stringify({ CLIP_S3: fixtureS3, CLIP_READY: "fixture-file-only" }), { mode: 0o600 });
    expect((await loadClipCredentials(home, config, {})).s3.endpoint).toBe(fixtureS3.endpoint);
    await chmod(path, 0o644);
    await expect(loadClipCredentials(home, config, {})).rejects.toThrow(/unreadable/);
    await writeFile(join(config.stateRoot, "conditional-create.json"), JSON.stringify({ verified: true, destination: config.destination, endpoint: fixtureS3.endpoint, testedAt: new Date().toISOString() }));
    expect(await conditionalCreateProven(config, fixtureS3.endpoint)).toBe(true);
    expect(await conditionalCreateProven(config, "https://another.example.com")).toBe(false);
    await rm(home, { recursive: true });
  });
});
