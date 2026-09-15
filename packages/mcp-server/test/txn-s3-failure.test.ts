import { describe, expect, it } from "vitest";
import { isS3Failure, S3PutError } from "../src/txn.js";

describe("isS3Failure", () => {
  it("S3PutError is true; a plain Error is false", () => {
    expect(isS3Failure(new S3PutError("S3 put failed"))).toBe(true);
    expect(isS3Failure(new Error("plain failure"))).toBe(false);
  });
});
