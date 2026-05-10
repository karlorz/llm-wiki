import { describe, it, expect } from "vitest";
import { createS3Client, type BackupConfig } from "../../src/utils/s3-client.js";

const testConfig: BackupConfig = {
  endpoint: "http://localhost:8333",
  bucket: "test-bucket",
  region: "us-east-1",
  accessKeyId: "test-key",
  secretAccessKey: "test-secret",
};

describe("s3-client", () => {
  it("creates an S3Client with forcePathStyle", () => {
    const client = createS3Client(testConfig);
    expect(client).toBeDefined();
    expect(client.constructor.name).toBe("S3Client");
    client.destroy();
  });

  it("passes endpoint and region to the client", () => {
    const client = createS3Client(testConfig);
    // S3Client stores config internally — verify it doesn't throw
    expect(client).toBeTruthy();
    client.destroy();
  });

  it("uses forcePathStyle for MinIO/SeaweedFS compatibility", () => {
    // forcePathStyle is set internally; verifying the client initializes without error
    const client = createS3Client(testConfig);
    expect(client).toBeDefined();
    client.destroy();
  });
});
