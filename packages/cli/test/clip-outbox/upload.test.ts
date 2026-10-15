import { describe, expect, it, vi } from "vitest";
import { GetObjectCommand, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { createS3CreateOnlyPut } from "../../src/clip-outbox/upload.js";
import { postReadyHint } from "../../src/clip-outbox/ready.js";

function fakeStore() {
  const objects = new Map<string, Buffer>();
  const send = vi.fn(async (command: GetObjectCommand | PutObjectCommand) => {
    const key = command.input.Key!;
    if (command instanceof GetObjectCommand) {
      const body = objects.get(key);
      if (!body) throw { name: "NoSuchKey", $metadata: { httpStatusCode: 404 } };
      return { Body: { transformToByteArray: async () => body } };
    }
    expect(command.input.IfNoneMatch).toBe("*");
    if (objects.has(key)) throw { name: "PreconditionFailed", $metadata: { httpStatusCode: 412 } };
    objects.set(key, command.input.Body as Buffer);
    return {};
  });
  const put = createS3CreateOnlyPut({ client: { send } as unknown as S3Client, bucket: "fixture", prefix: "isolated" });
  return { objects, send, put };
}
describe("verified conditional creation", () => {
  it("hashes a readback after creation, reuses identical objects and blocks conflicts", async () => {
    const { put, send } = fakeStore();
    const key = "raw/assets/a/image.png";
    expect(await put(key, Buffer.from("one"))).toEqual({ status: "created" });
    expect(send.mock.calls.filter(([c]) => !c.input.Key?.includes("delete-intents")).map(([c]) => c.constructor.name)).toEqual(["GetObjectCommand", "PutObjectCommand", "GetObjectCommand"]);
    expect(await put(key, Buffer.from("one"))).toEqual({ status: "idempotent" });
    expect(await put(key, Buffer.from("two"))).toEqual({ status: "conflict" });
    expect(send.mock.calls.filter(([c]) => c instanceof PutObjectCommand)).toHaveLength(1);
  });
  it("inspects unknown put outcomes on retry", async () => {
    const { put, send, objects } = fakeStore();
    for (let i = 0; i < 4; i++) send.mockImplementationOnce(async () => { throw { name: "NoSuchKey" }; });
    send.mockImplementationOnce(async () => {
      objects.set("isolated/raw/articles/a.md", Buffer.from("bytes"));
      throw new Error("timeout after put");
    });
    await expect(put("raw/articles/a.md", Buffer.from("bytes"))).rejects.toThrow(/timeout/);
    expect(await put("raw/articles/a.md", Buffer.from("bytes"))).toEqual({ status: "idempotent" });
  });
  it("holds an active ancestor tombstone before any put", async () => {
    const { objects, send, put } = fakeStore();
    objects.set("isolated/meta/delete-intents/raw__assets__deleted.json", Buffer.from(JSON.stringify({ schema: "vault-delete-intent/v1", path: "raw/assets/deleted", action: "remove", expires: null })));
    await expect(put("raw/assets/deleted/image.png", Buffer.from("x"))).rejects.toThrow(/TOMBSTONE_HOLD/);
    expect(send.mock.calls.filter(([c]) => c instanceof PutObjectCommand)).toHaveLength(0);
  });
  it("does not call storage for unsafe keys", async () => {
    const { put, send } = fakeStore();
    await expect(put("raw/articles/../../credentials", Buffer.from("x"))).rejects.toThrow(/unsafe/);
    expect(send).not.toHaveBeenCalled();
  });
  it("distinguishes queued from verified central adoption and bounds ready requests", async () => {
    const hint = { vault_id: "central", files: [{ path: "raw/articles/a.md", sha256: "a".repeat(64) }] };
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ status: "queued" }), { status: 202 }));
    expect(await postReadyHint({ url: "https://example.com/file-ingress/ready", token: "fixture-file-channel", hint, fetchImpl })).toEqual({ ok: false, status: 503 });
    fetchImpl.mockResolvedValue(new Response(JSON.stringify({ ok: true, paths: ["raw/articles/a.md"] })));
    expect(await postReadyHint({ url: "https://example.com/file-ingress/ready", token: "fixture-file-channel", hint, fetchImpl })).toEqual({ ok: true });
    expect(fetchImpl.mock.calls[0][1]?.redirect).toBe("error");
    expect(fetchImpl.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
  });
});
