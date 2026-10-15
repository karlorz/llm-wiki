import { createHash } from "node:crypto";
import { PutObjectCommand, GetObjectCommand, S3Client, S3ServiceException } from "@aws-sdk/client-s3";

export type CreateOnlyResult =
  | { status: "created" }
  | { status: "idempotent" }
  | { status: "conflict" };

export interface CreateOnlyPut {
  (key: string, body: Buffer): Promise<CreateOnlyResult>;
}

export function sha256Hex(body: Buffer): string {
  return createHash("sha256").update(body).digest("hex");
}

export function parseDestination(destination: string): { remote: string; bucket: string; prefix: string } {
  const colon = destination.indexOf(":");
  if (colon <= 0) throw new Error("invalid destination");
  const remote = destination.slice(0, colon);
  const rest = destination.slice(colon + 1);
  const slash = rest.indexOf("/");
  if (slash <= 0) return { remote, bucket: rest, prefix: "" };
  return { remote, bucket: rest.slice(0, slash), prefix: rest.slice(slash + 1) };
}

export function createS3CreateOnlyPut(opts: {
  client: S3Client;
  bucket: string;
  prefix?: string;
}): CreateOnlyPut {
  const prefix = opts.prefix ?? "";
  const resolveKey = (rel: string) => [prefix, rel].filter(Boolean).join("/");
  return async (key, body) => {
    const objectKey = resolveKey(key);
    try {
      await opts.client.send(new PutObjectCommand({
        Bucket: opts.bucket,
        Key: objectKey,
        Body: body,
        IfNoneMatch: "*",
      }));
      return { status: "created" };
    } catch (error: unknown) {
      const name = error instanceof S3ServiceException ? error.name : (error as { name?: string }).name;
      const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      if (name === "PreconditionFailed" || status === 412) {
        const existing = await opts.client.send(new GetObjectCommand({ Bucket: opts.bucket, Key: objectKey }));
        const bytes = existing.Body ? Buffer.from(await existing.Body.transformToByteArray()) : Buffer.alloc(0);
        return sha256Hex(bytes) === sha256Hex(body)
          ? { status: "idempotent" }
          : { status: "conflict" };
      }
      throw error;
    }
  };
}

export async function uploadBundle(opts: {
  put: CreateOnlyPut;
  articleKey: string;
  article: Buffer;
  assets: Array<{ key: string; body: Buffer }>;
}): Promise<{ ok: true } | { ok: false; reason: string; articlePut: boolean }> {
  for (const asset of opts.assets) {
    const result = await opts.put(asset.key, asset.body);
    if (result.status === "conflict") {
      return { ok: false, reason: `asset conflict: ${asset.key}`, articlePut: false };
    }
  }
  const article = await opts.put(opts.articleKey, opts.article);
  if (article.status === "conflict") {
    return { ok: false, reason: `article conflict: ${opts.articleKey}`, articlePut: false };
  }
  return { ok: true };
}
