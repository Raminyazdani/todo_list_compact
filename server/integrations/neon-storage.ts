import { createHash } from "node:crypto";
import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { DomainError } from "../../shared/contracts";

const REQUEST_TIMEOUT_MS = 30_000;
const hash = (bytes: string | Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
type ObjectKind = "files" | "backups";

function configuration() {
  const endpoint = process.env.NEON_STORAGE_ENDPOINT_URL_S3,
    region = process.env.NEON_STORAGE_REGION,
    bucket = process.env.NEON_STORAGE_BUCKET,
    accessKeyId = process.env.NEON_STORAGE_ACCESS_KEY_ID,
    secretAccessKey = process.env.NEON_STORAGE_SECRET_ACCESS_KEY;
  if (!endpoint || !region || !bucket || !accessKeyId || !secretAccessKey)
    return null;
  try {
    const url = new URL(endpoint);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.port && url.port !== "443") ||
      !/^[a-z]{2}-[a-z]+-\d$/.test(region) ||
      !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) ||
      bucket.includes("..")
    )
      return null;
    return { endpoint, region, bucket, accessKeyId, secretAccessKey };
  } catch {
    return null;
  }
}

/** Configuration is not evidence of a live provider connection or conditional PUT support. */
export function neonStorageCapabilities() {
  const configured = configuration() !== null;
  const immutable_put_verified =
    process.env.NEON_STORAGE_IMMUTABLE_PUT_VERIFIED === "true";
  return {
    configured,
    immutable_put_verified,
    connected: configured && immutable_put_verified,
  };
}

export function ownerNeonBackupKey(ownerId: string, day: string) {
  return `owners/${hash(ownerId)}/backups/${day}.json`;
}

function requireKey(key: string, ownerId: string, kind: ObjectKind) {
  const prefix = `owners/${hash(ownerId)}/${kind}/`;
  const suffix = key.slice(prefix.length);
  if (
    !ownerId ||
    !key.startsWith(prefix) ||
    !(kind === "files"
      ? /^[a-f0-9]{64}\/original$/.test(suffix)
      : /^\d{4}-\d{2}-\d{2}\.json$/.test(suffix))
  )
    throw new DomainError(
      "INSUFFICIENT_PERMISSIONS",
      "Private storage key is outside the owner namespace.",
      {},
      403,
    );
}

function disconnected() {
  return new DomainError(
    "UNSUPPORTED_OPERATION",
    "Private Neon storage is disconnected or its immutable PUT gate is unverified.",
    {},
    503,
  );
}

function createClient(write: boolean) {
  const config = configuration();
  if (!config || (write && !neonStorageCapabilities().immutable_put_verified))
    throw disconnected();
  return {
    bucket: config.bucket,
    client: new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
      forcePathStyle: true,
      authSchemePreference: ["aws.auth#sigv4"],
      maxAttempts: 1,
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
      requestHandler: { connectionTimeout: 5_000, requestTimeout: 30_000 },
    }),
  };
}

function status(error: unknown) {
  return (error as { $metadata?: { httpStatusCode?: number } } | null)
    ?.$metadata?.httpStatusCode;
}

/** Only a definite missing object permits a subsequent PUT. Other errors fail closed. */
export async function readNeonObject(
  key: string,
  ownerId: string,
  kind: ObjectKind,
  maxBytes: number,
): Promise<Buffer | null> {
  requireKey(key, ownerId, kind);
  const { client, bucket } = createClient(false);
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      abort.abort();
      reject(new Error("PRIVATE_READ_TIMEOUT"));
    }, REQUEST_TIMEOUT_MS);
  });
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const result = await Promise.race([
      client.send(new GetObjectCommand({ Bucket: bucket, Key: key }), {
        abortSignal: abort.signal,
      }),
      timeout,
    ]);
    if (!result.Body) throw new Error("PRIVATE_BODY_MISSING");
    const stream =
      result.Body instanceof ReadableStream
        ? result.Body
        : result.Body.transformToWebStream();
    reader = stream.getReader();
    if (
      result.ContentLength !== undefined &&
      (!Number.isSafeInteger(result.ContentLength) ||
        result.ContentLength < 0 ||
        result.ContentLength > maxBytes)
    )
      throw new DomainError(
        "INVALID_INPUT",
        "Private object exceeds size policy.",
      );
    const chunks: Uint8Array[] = [];
    let length = 0;
    while (true) {
      const next = await Promise.race([reader.read(), timeout]);
      if (next.done) break;
      length += next.value.byteLength;
      if (length > maxBytes)
        throw new DomainError(
          "INVALID_INPUT",
          "Private object exceeds size policy.",
        );
      chunks.push(next.value);
    }
    if (result.ContentLength !== undefined && length !== result.ContentLength)
      throw new Error("PRIVATE_READ_LENGTH_MISMATCH");
    return Buffer.concat(chunks, length);
  } catch (error) {
    if (status(error) === 404) return null;
    if (error instanceof DomainError) throw error;
    throw new DomainError(
      "UNSUPPORTED_OPERATION",
      "Private storage read failed; retry the same object after reconciliation.",
      {},
      503,
    );
  } finally {
    clearTimeout(timer!);
    abort.abort();
    client.destroy();
    if (reader) {
      void reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }
}

/** No SDK retries or unconditional fallback: a lost write response remains uncertain. */
export async function putNeonObject(
  key: string,
  ownerId: string,
  kind: ObjectKind,
  bytes: Uint8Array,
  mimeType: string,
  maxBytes: number,
) {
  requireKey(key, ownerId, kind);
  if (!bytes.length || bytes.length > maxBytes)
    throw new DomainError(
      "INVALID_INPUT",
      "Private object exceeds size policy.",
    );
  const { client, bucket } = createClient(true);
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      abort.abort();
      reject(new Error("PRIVATE_WRITE_TIMEOUT"));
    }, REQUEST_TIMEOUT_MS);
  });
  try {
    await Promise.race([
      client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: bytes,
          ContentLength: bytes.length,
          ContentType: mimeType,
          ContentDisposition: "attachment",
          CacheControl: "private, no-store",
          Metadata: { sha256: hash(bytes) },
          IfNoneMatch: "*",
        }),
        { abortSignal: abort.signal },
      ),
      timeout,
    ]);
  } catch (error) {
    // A competing conditional PUT may have won. The caller must verify its bytes.
    if (status(error) === 412) return;
    throw new DomainError(
      "UNSUPPORTED_OPERATION",
      "Private upload outcome is uncertain; reconcile the same storage key before retrying.",
      {},
      503,
    );
  } finally {
    clearTimeout(timer!);
    abort.abort();
    client.destroy();
  }
}
