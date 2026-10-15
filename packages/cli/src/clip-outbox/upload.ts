import { createHash } from "node:crypto";
import { PutObjectCommand, GetObjectCommand, S3Client, S3ServiceException } from "@aws-sdk/client-s3";
import { DELETE_INTENT_DIR, DELETE_INTENT_SCHEMA, pathToIntentFilename } from "../utils/delete-intent.js";

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
    if (!/^raw\/(articles|assets)\/[A-Za-z0-9._/-]+$/.test(key) || key.split("/").some((s) => s === ".." || s === "." || !s)) throw new Error("unsafe upload key");
    const objectKey = resolveKey(key);
    // Read current exact and ancestor delete intents from storage, not a possibly
    // stale mirror. Unknown/malformed policy is a hold, never permission to PUT.
    const parts = key.split("/");
    for (let count = 1; count <= parts.length; count++) {
      const target = parts.slice(0, count).join("/");
      let intentBody: Buffer;
      try {
        const intent = await opts.client.send(new GetObjectCommand({ Bucket: opts.bucket, Key: resolveKey(`${DELETE_INTENT_DIR}/${pathToIntentFilename(target)}`) }));
        if (!intent.Body) throw new Error("DELETE_INTENT_UNAVAILABLE");
        intentBody = Buffer.from(await intent.Body.transformToByteArray());
      } catch (error) {
        if ((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404 || (error as { name?: string }).name === "NoSuchKey") continue;
        throw error;
      }
      const intent = JSON.parse(intentBody.toString("utf8")) as { schema?: string; path?: string; expires?: string | null; action?: string };
      if (intent.schema !== DELETE_INTENT_SCHEMA || intent.path !== target || !["remove", "archive"].includes(intent.action ?? "")) throw new Error("DELETE_INTENT_UNAVAILABLE");
      if (!intent.expires || !Number.isFinite(Date.parse(intent.expires)) || Date.parse(intent.expires) > Date.now()) throw new Error("TOMBSTONE_HOLD");
    }
    const inspect = async (): Promise<"absent" | "idempotent" | "conflict"> => {
      try {
        const existing = await opts.client.send(new GetObjectCommand({ Bucket: opts.bucket, Key: objectKey }));
        if (!existing.Body) throw new Error("missing S3 response body");
        const bytes = Buffer.from(await existing.Body.transformToByteArray());
        return bytes.length === body.length && sha256Hex(bytes) === sha256Hex(body) ? "idempotent" : "conflict";
      } catch (error) {
        if ((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404 || (error as { name?: string }).name === "NoSuchKey") return "absent";
        throw error;
      }
    };
    const prior = await inspect();
    if (prior !== "absent") return { status: prior };
    try {
      await opts.client.send(new PutObjectCommand({
        Bucket: opts.bucket,
        Key: objectKey,
        Body: body,
        IfNoneMatch: "*",
      }));
    } catch (error: unknown) {
      const name = error instanceof S3ServiceException ? error.name : (error as { name?: string }).name;
      const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      if (name === "PreconditionFailed" || status === 412) {
        const outcome = await inspect();
        if (outcome !== "absent") return { status: outcome };
      }
      throw error;
    }
    const verified = await inspect();
    if (verified === "absent") throw new Error("S3 verification pending");
    return { status: verified === "conflict" ? "conflict" : "created" };
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
