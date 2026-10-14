import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import type { Principal } from "../../shared/contracts";

const transport = vi.hoisted(() => ({
  objects: new Map<string, Uint8Array>(),
  configs: [] as Array<Record<string, unknown>>,
  send: vi.fn(),
  destroy: vi.fn(),
  blobGet: vi.fn(),
  blobPut: vi.fn(),
}));
vi.mock("@aws-sdk/client-s3", async (original) => {
  const sdk = await original<typeof import("@aws-sdk/client-s3")>();
  return {
    ...sdk,
    S3Client: class {
      constructor(config: Record<string, unknown>) {
        transport.configs.push(config);
      }
      send = transport.send;
      destroy = transport.destroy;
    },
  };
});
vi.mock("@vercel/blob", () => ({
  get: transport.blobGet,
  put: transport.blobPut,
}));
import {
  backupStorageCapabilities,
  MAX_UPLOAD_BYTES,
  ownerStoragePrefix,
  readPrivateFile,
  storageCapabilities,
  uploadPrivateFile,
  verifyPrivateFileMetadata,
} from "../../server/integrations/storage";
import { readNeonObject } from "../../server/integrations/neon-storage";

const principal: Principal = {
  ownerId: "synthetic-neon-owner",
  actorId: "synthetic-neon-owner",
  channel: "UI",
  scopes: ["files:read", "files:write"],
};
const bytes = Buffer.from("Private original\nمتن"),
  operation = "synthetic-neon-upload-operation";
const key = () =>
  ownerStoragePrefix(principal.ownerId) +
  createHash("sha256").update(operation).digest("hex") +
  "/original";
const object = (value: Uint8Array) => ({
  Body: new Response(new Uint8Array(value)).body!,
  ContentLength: value.byteLength,
});

beforeEach(() => {
  transport.objects.clear();
  transport.configs.length = 0;
  transport.send.mockReset();
  transport.destroy.mockReset();
  transport.blobGet.mockReset();
  transport.blobPut.mockReset();
  vi.stubEnv("PRIVATE_STORAGE_PROVIDER", "neon_object_storage");
  vi.stubEnv(
    "NEON_STORAGE_ENDPOINT_URL_S3",
    "https://synthetic.storage.neon.tech",
  );
  vi.stubEnv("NEON_STORAGE_REGION", "eu-central-1");
  vi.stubEnv("NEON_STORAGE_BUCKET", "synthetic-private-bucket");
  vi.stubEnv("NEON_STORAGE_ACCESS_KEY_ID", "synthetic-access-key");
  vi.stubEnv("NEON_STORAGE_SECRET_ACCESS_KEY", "synthetic-secret-key");
  // This simulates an operator gate; a mocked transport does not prove live support.
  vi.stubEnv("NEON_STORAGE_IMMUTABLE_PUT_VERIFIED", "true");
  vi.stubEnv("BLOB_READ_WRITE_TOKEN", "synthetic-legacy-blob-token");
  vi.stubEnv("BACKUP_ENCRYPTION_KEY", "");
  transport.send.mockImplementation(async (command) => {
    const { Key } = command.input;
    if (command instanceof GetObjectCommand) {
      const stored = transport.objects.get(Key);
      if (!stored) throw { $metadata: { httpStatusCode: 404 } };
      return object(stored);
    }
    expect(command).toBeInstanceOf(PutObjectCommand);
    expect(command.input.IfNoneMatch).toBe("*");
    if (transport.objects.has(Key))
      throw { $metadata: { httpStatusCode: 412 } };
    transport.objects.set(Key, new Uint8Array(command.input.Body));
    return {};
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});
const upload = (value = bytes, op = operation) =>
  uploadPrivateFile(value, "synthetic.txt", "text/plain", principal, op);
const puts = () =>
  transport.send.mock.calls.filter(
    ([command]) => command instanceof PutObjectCommand,
  );

describe("Neon private S3 adapter with mocked transport (not live provider proof)", () => {
  it("uses explicit SigV4/path-style credentials with one attempt and private immutable PUT", async () => {
    const result = await upload();
    expect(result.provider).toBe("neon_object_storage");
    expect(result.storage_key).not.toContain(principal.ownerId);
    expect(
      transport.configs.every(
        (config) => config.forcePathStyle === true && config.maxAttempts === 1,
      ),
    ).toBe(true);
    expect(transport.configs[0]).toMatchObject({
      endpoint: "https://synthetic.storage.neon.tech",
      region: "eu-central-1",
      credentials: {
        accessKeyId: "synthetic-access-key",
        secretAccessKey: "synthetic-secret-key",
      },
      authSchemePreference: ["aws.auth#sigv4"],
      requestChecksumCalculation: "WHEN_REQUIRED",
    });
    const [command, options] = puts()[0];
    expect(command.input).toMatchObject({
      Bucket: "synthetic-private-bucket",
      Key: result.storage_key,
      IfNoneMatch: "*",
      CacheControl: "private, no-store",
      ContentDisposition: "attachment",
      ContentType: "text/plain",
      Metadata: { sha256: result.sha256 },
      ContentLength: bytes.length,
    });
    expect(options.abortSignal).toBeInstanceOf(AbortSignal);
    expect(transport.blobGet).not.toHaveBeenCalled();
    expect(transport.blobPut).not.toHaveBeenCalled();
    expect(
      await verifyPrivateFileMetadata(
        result.storage_key,
        principal,
        result.provider,
      ),
    ).toEqual({ sha256: result.sha256, size_bytes: bytes.length });
    const stream = await readPrivateFile(
      result.storage_key,
      principal,
      result.provider,
    );
    expect(Buffer.from(await new Response(stream).arrayBuffer())).toEqual(
      bytes,
    );
  });

  it("fails closed with missing Neon configuration despite ambient AWS and Blob credentials", async () => {
    vi.stubEnv("NEON_STORAGE_SECRET_ACCESS_KEY", "");
    vi.stubEnv("AWS_ACCESS_KEY_ID", "ambient-access");
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", "ambient-secret");
    expect(storageCapabilities()).toMatchObject({
      configured: false,
      connected: false,
    });
    await expect(upload()).rejects.toMatchObject({
      code: "UNSUPPORTED_OPERATION",
    });
    expect(transport.send).not.toHaveBeenCalled();
    expect(transport.blobPut).not.toHaveBeenCalled();
  });

  it.each([
    "http://synthetic.storage.neon.tech",
    "https://user:pass@synthetic.storage.neon.tech",
    "https://synthetic.storage.neon.tech?secret=value",
  ])("rejects unsafe endpoint configuration %s", async (endpoint) => {
    vi.stubEnv("NEON_STORAGE_ENDPOINT_URL_S3", endpoint);
    await expect(upload()).rejects.toMatchObject({
      code: "UNSUPPORTED_OPERATION",
    });
    expect(transport.send).not.toHaveBeenCalled();
  });

  it("blocks all PUTs until operator immutability proof while allowing authenticated reads", async () => {
    vi.stubEnv("NEON_STORAGE_IMMUTABLE_PUT_VERIFIED", "");
    transport.objects.set(key(), bytes);
    expect(storageCapabilities()).toMatchObject({
      configured: true,
      connected: false,
      immutable_put_verified: false,
    });
    await expect(upload()).rejects.toMatchObject({
      code: "UNSUPPORTED_OPERATION",
    });
    expect(transport.send).not.toHaveBeenCalled();
    expect(
      await verifyPrivateFileMetadata(key(), principal, "neon_object_storage"),
    ).toMatchObject({ size_bytes: bytes.length });
    expect(puts()).toHaveLength(0);
  });

  it("checks backup encryption independently of file configuration", () => {
    expect(storageCapabilities().connected).toBe(true);
    expect(backupStorageCapabilities()).toMatchObject({
      connected: false,
      encryption_configured: false,
    });
    vi.stubEnv("BACKUP_ENCRYPTION_KEY", "synthetic-encryption-key");
    expect(backupStorageCapabilities()).toMatchObject({
      connected: true,
      encryption_configured: true,
    });
  });

  it("reconciles same-key bytes, rejects different payload and preserves distinct versions", async () => {
    const original = await upload();
    expect((await upload()).storage_key).toBe(original.storage_key);
    await expect(upload(Buffer.from("changed"))).rejects.toMatchObject({
      code: "IDEMPOTENCY_CONFLICT",
    });
    expect(puts()).toHaveLength(1);
    const version = await upload(Buffer.from("changed"), operation + "-v2");
    expect(version.storage_key).not.toBe(original.storage_key);
    expect(transport.objects.get(original.storage_key)).toEqual(
      new Uint8Array(bytes),
    );
  });

  it("retries an uncertain accepted PUT by reading the same key and never repeating the write", async () => {
    const normalSend = transport.send.getMockImplementation()!;
    transport.send.mockImplementation(async (...args) => {
      const result = await normalSend(...args);
      if (args[0] instanceof PutObjectCommand)
        throw new Error(
          "synthetic response lost with private credential/URL text",
        );
      return result;
    });
    await expect(upload()).rejects.toMatchObject({
      code: "UNSUPPORTED_OPERATION",
      status: 503,
    });
    expect((await upload()).provider).toBe("neon_object_storage");
    expect(puts()).toHaveLength(1);
  });

  it("does not treat permission or network errors as missing objects and redacts provider details", async () => {
    transport.send.mockRejectedValue(
      new Error("synthetic-private-token-and-endpoint"),
    );
    await expect(upload()).rejects.toThrow(/Private storage read failed/);
    expect(puts()).toHaveLength(0);
    expect(transport.destroy).toHaveBeenCalledTimes(1);
  });

  it.each([true, false])(
    "verifies concurrent conditional rejection bytes (same payload=%s)",
    async (same) => {
      let reads = 0;
      transport.send.mockImplementation(async (command) => {
        if (command instanceof GetObjectCommand) {
          if (!reads++) throw { $metadata: { httpStatusCode: 404 } };
          return object(
            same ? bytes : Buffer.from("competitor different bytes"),
          );
        }
        throw { $metadata: { httpStatusCode: 412 } };
      });
      if (same) expect((await upload()).sha256).toHaveLength(64);
      else await expect(upload()).rejects.toThrow(/checksum/);
      expect(puts()).toHaveLength(1);
    },
  );

  it("rejects wrong owner, scope, MIME signature and oversized uploads before transport", async () => {
    await expect(
      readPrivateFile(
        key(),
        { ...principal, ownerId: "other-owner" },
        "neon_object_storage",
      ),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_PERMISSIONS" });
    await expect(
      uploadPrivateFile(
        bytes,
        "synthetic.txt",
        "text/plain",
        { ...principal, scopes: ["files:read"] },
        operation,
      ),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_PERMISSIONS" });
    await expect(
      uploadPrivateFile(
        bytes,
        "synthetic.pdf",
        "application/pdf",
        principal,
        operation,
      ),
    ).rejects.toThrow(/signature/);
    await expect(
      upload(Buffer.alloc(MAX_UPLOAD_BYTES + 1)),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(transport.send).not.toHaveBeenCalled();
  });

  it("uses the authoritative legacy provider independently of selected Neon uploads", async () => {
    transport.blobGet.mockResolvedValue({
      statusCode: 200,
      stream: object(bytes).Body,
    });
    const stream = await readPrivateFile(key(), principal);
    expect(Buffer.from(await new Response(stream).arrayBuffer())).toEqual(
      bytes,
    );
    expect(transport.blobGet).toHaveBeenCalledTimes(1);
    expect(transport.send).not.toHaveBeenCalled();
    transport.blobGet.mockClear();
    await expect(
      readPrivateFile(key(), principal, "neon_object_storage"),
    ).rejects.toMatchObject({ code: "ENTITY_NOT_FOUND" });
    expect(transport.blobGet).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    "cancels oversized read bodies (declared size=%s)",
    async (declared) => {
      const cancel = vi.fn();
      transport.send.mockResolvedValue({
        ...(declared ? { ContentLength: MAX_UPLOAD_BYTES + 1 } : {}),
        Body: new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(MAX_UPLOAD_BYTES + 1));
          },
          cancel,
        }),
      });
      await expect(
        verifyPrivateFileMetadata(key(), principal, "neon_object_storage"),
      ).rejects.toMatchObject({ code: "INVALID_INPUT" });
      expect(cancel).toHaveBeenCalled();
      expect(transport.destroy).toHaveBeenCalled();
    },
  );

  it("bounds a stalled read and releases the SDK client without leaking provider errors", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    transport.send.mockResolvedValue({ Body: new ReadableStream({ cancel }) });
    const pending = readNeonObject(
      key(),
      principal.ownerId,
      "files",
      MAX_UPLOAD_BYTES,
    );
    const assertion = expect(pending).rejects.toMatchObject({
      code: "UNSUPPORTED_OPERATION",
    });
    await vi.advanceTimersByTimeAsync(30_000);
    await assertion;
    expect(cancel).toHaveBeenCalled();
    expect(transport.destroy).toHaveBeenCalledTimes(1);
  });
});
