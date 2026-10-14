import { createHash, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "../../server/db/database";
import type { DomainService, FileDTO, Principal } from "../../shared/contracts";
import { createDomainService } from "../../server/domain/service";
import { hash } from "../../server/domain/core";
import { ownerStoragePrefix } from "../../server/integrations/storage";
import { createTestDatabase } from "./database";

// Only the SDK transports are mocked. Canonical owner/scope/revision/idempotency,
// provider dispatch, bounded byte verification and SQL transactions run normally.
const transport = vi.hoisted(() => ({
  neon: new Map<string, Uint8Array>(),
  blob: new Map<string, Uint8Array>(),
  send: vi.fn(),
  getBlob: vi.fn(),
}));
vi.mock("@aws-sdk/client-s3", async (original) => {
  const sdk = await original<typeof import("@aws-sdk/client-s3")>();
  return {
    ...sdk,
    S3Client: class {
      send = transport.send;
      destroy() {}
    },
  };
});
vi.mock("@vercel/blob", () => ({
  get: transport.getBlob,
  put: vi.fn(),
}));

const principal: Principal = {
  ownerId: "synthetic-canonical-provider-owner",
  actorId: "synthetic-provider-human",
  channel: "UI",
  scopes: ["admin:manage"],
};
const bytes = Buffer.from("synthetic immutable original\nمتن");
const sha = (value: Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
const storageKey = (operation: string, owner = principal.ownerId) =>
  ownerStoragePrefix(owner) + sha(Buffer.from(operation)) + "/original";
let db: Database, service: DomainService;
beforeEach(async () => {
  transport.neon.clear();
  transport.blob.clear();
  transport.send.mockReset();
  transport.getBlob.mockReset();
  vi.stubEnv("PRIVATE_STORAGE_PROVIDER", "neon_object_storage");
  vi.stubEnv(
    "NEON_STORAGE_ENDPOINT_URL_S3",
    "https://synthetic-storage.neon.tech",
  );
  vi.stubEnv("NEON_STORAGE_REGION", "eu-central-1");
  vi.stubEnv("NEON_STORAGE_BUCKET", "synthetic-private-files");
  vi.stubEnv("NEON_STORAGE_ACCESS_KEY_ID", "synthetic-access-key");
  vi.stubEnv("NEON_STORAGE_SECRET_ACCESS_KEY", "synthetic-secret-key");
  vi.stubEnv("NEON_STORAGE_IMMUTABLE_PUT_VERIFIED", "true");
  vi.stubEnv("BLOB_READ_WRITE_TOKEN", "synthetic-legacy-blob-token");
  vi.stubEnv("BACKUP_ENCRYPTION_KEY", "");
  transport.send.mockImplementation(
    async (command: { input: { Key: string } }) => {
      const value = transport.neon.get(command.input.Key);
      if (!value)
        throw Object.assign(new Error("Synthetic object unavailable"), {
          name: "NoSuchKey",
          $metadata: { httpStatusCode: 404 },
        });
      return {
        ContentLength: value.byteLength,
        Body: new Response(Buffer.from(value)).body,
      };
    },
  );
  transport.getBlob.mockImplementation(async (key: string) => {
    const value = transport.blob.get(key);
    return value
      ? { statusCode: 200, stream: new Response(Buffer.from(value)).body }
      : null;
  });
  db = await createTestDatabase();
  service = createDomainService(db);
});
afterEach(async () => {
  await db.close?.();
  vi.unstubAllEnvs();
});
async function persisted() {
  const tables = [
    "files",
    "file_versions",
    "activity_events",
    "idempotency_operations",
  ];
  return Promise.all(
    tables.map(async (table) => ({
      table,
      rows: (
        await db.query(`SELECT * FROM ${table} WHERE owner_id=$1 ORDER BY 1`, [
          principal.ownerId,
        ])
      ).rows,
    })),
  );
}
const metadata = (fileId: string) =>
  service.query(
    "file_get_metadata",
    { file_id: fileId },
    principal,
  ) as Promise<FileDTO>;

describe("canonical private provider registration on isolated PostgreSQL with SDK-only fixtures", () => {
  it("selected Neon backup health never adopts a historical Blob or foreign namespace receipt", async () => {
    await db.query("INSERT INTO owners(owner_id) VALUES($1)", [
      principal.ownerId,
    ]);
    const ownerHash = sha(Buffer.from(principal.ownerId));
    const blobKey = `life-os-backups/${ownerHash.slice(0, 32)}/2026-01-01.json`;
    const neonKey = `owners/${ownerHash}/backups/2026-01-03.json`;
    const blobVerified = "2026-01-01T08:00:00.000Z";
    const foreignVerified = "2026-01-02T08:00:00.000Z";
    const neonVerified = "2026-01-03T08:00:00.000Z";
    const receipt = async (
      receiptId: string,
      key: string,
      verifiedAt: string,
    ) =>
      db.query(
        "INSERT INTO backup_runs(backup_id,owner_id,status,storage_key,manifest_hash,created_at,verified_at) VALUES($1,$2,'verified',$3,$4,$5,$5)",
        [receiptId, principal.ownerId, key, "0".repeat(64), verifiedAt],
      );
    await receipt("synthetic-blob-receipt", blobKey, blobVerified);
    expect(await service.query("system_health", {}, principal)).toMatchObject({
      backup_storage_provider: "neon_object_storage",
      backup_configured: false,
      backup_status: "disconnected",
      latest_verified_backup_at: null,
      historical_latest_verified_backup_at: blobVerified,
    });
    vi.stubEnv("BACKUP_ENCRYPTION_KEY", Buffer.alloc(32, 1).toString("base64"));
    expect(await service.query("system_health", {}, principal)).toMatchObject({
      backup_configured: true,
      backup_status: "none",
      latest_verified_backup_at: null,
      historical_latest_verified_backup_at: blobVerified,
    });
    // Same owner column does not qualify a key belonging to another namespace.
    await receipt(
      "synthetic-foreign-namespace-receipt",
      `owners/${sha(Buffer.from("synthetic-other-owner"))}/backups/2026-01-02.json`,
      foreignVerified,
    );
    expect(await service.query("system_health", {}, principal)).toMatchObject({
      backup_status: "none",
      latest_verified_backup_at: null,
      historical_latest_verified_backup_at: foreignVerified,
    });
    await receipt("synthetic-neon-receipt", neonKey, neonVerified);
    const selected = await service.query("system_health", {}, principal);
    expect(selected).toMatchObject({
      backup_status: "verified",
      latest_verified_backup_at: neonVerified,
      historical_latest_verified_backup_at: neonVerified,
    });
    expect(JSON.stringify(selected)).not.toContain(ownerHash);
    expect(JSON.stringify(selected)).not.toContain(neonKey);
    vi.stubEnv("NEON_STORAGE_IMMUTABLE_PUT_VERIFIED", "false");
    expect(await service.query("system_health", {}, principal)).toMatchObject({
      backup_status: "disconnected",
      latest_verified_backup_at: neonVerified,
    });
    vi.stubEnv("PRIVATE_STORAGE_PROVIDER", "private_blob");
    expect(await service.query("system_health", {}, principal)).toMatchObject({
      backup_status: "verified",
      latest_verified_backup_at: blobVerified,
      historical_latest_verified_backup_at: neonVerified,
    });
    expect(transport.send).not.toHaveBeenCalled();
    expect(transport.getBlob).not.toHaveBeenCalled();
  });

  it("owner health separates selected file readiness, immutable-provider admission, encrypted backup readiness and deferred AI", async () => {
    expect(
      await service.query("system_capabilities", {}, principal),
    ).toMatchObject({
      storage_provider: "neon_object_storage",
      storage_configured: true,
      ai_configured: false,
      AI_configured: false,
      in_app_ai_enabled: false,
      in_app_ai_status: "deferred",
    });
    expect(await service.query("system_health", {}, principal)).toMatchObject({
      private_storage_provider: "neon_object_storage",
      private_storage_configured: true,
      backup_storage_provider: "neon_object_storage",
      backup_configured: false,
      backup_status: "disconnected",
      latest_verified_backup_at: null,
    });
    vi.stubEnv("NEON_STORAGE_IMMUTABLE_PUT_VERIFIED", "false");
    expect(
      await service.query("system_capabilities", {}, principal),
    ).toMatchObject({
      storage_provider: "neon_object_storage",
      storage_configured: false,
    });
    vi.stubEnv("PRIVATE_STORAGE_PROVIDER", "private_blob");
    expect(
      await service.query("system_capabilities", {}, principal),
    ).toMatchObject({
      storage_provider: "private_blob",
      storage_configured: true,
    });
    expect(transport.send).not.toHaveBeenCalled();
    expect(transport.getBlob).not.toHaveBeenCalled();
  });

  it("Neon registration verifies actual fixture bytes, receipts and immutable versions while legacy omission still selects Blob", async () => {
    const oldKey = storageKey("synthetic-blob-v1");
    transport.blob.set(oldKey, bytes);
    const original = await service.execute(
      "file_register_upload",
      {
        title: "Synthetic original",
        original_filename: "original.txt",
        storage_key: oldKey,
      },
      principal,
      { idempotencyKey: "synthetic-blob-registration" },
    );
    expect((await metadata(original.entity_id)).provider).toBe("private_blob");
    expect(transport.send).not.toHaveBeenCalled();
    const before = hash(await persisted());
    const originalRow = await metadata(original.entity_id);
    const nextBytes = Buffer.from("synthetic new immutable version");
    const nextKey = storageKey("synthetic-neon-v2");
    transport.neon.set(nextKey, nextBytes);
    const input = {
      file_id: original.entity_id,
      title: "Synthetic Neon version",
      original_filename: "original.txt",
      storage_key: nextKey,
      provider: "neon_object_storage",
      sha256: sha(nextBytes),
      size_bytes: nextBytes.length,
    };
    const options = {
      idempotencyKey: "synthetic-neon-registration",
      expectedRevision: original.version,
    };
    const version = await service.execute(
      "file_register_upload",
      input,
      principal,
      options,
    );
    expect(version.entity_id).not.toBe(original.entity_id);
    expect(await metadata(version.entity_id)).toMatchObject({
      provider: "neon_object_storage",
      sha256: sha(nextBytes),
      size_bytes: nextBytes.length,
      version_group_id: originalRow.version_group_id,
    });
    expect(await metadata(original.entity_id)).toEqual(originalRow);
    expect(hash(await persisted())).not.toBe(before);
    const accepted = hash(await persisted());
    transport.send.mockClear();
    expect(
      await service.execute("file_register_upload", input, principal, options),
    ).toMatchObject({
      entity_id: version.entity_id,
      operation_id: version.operation_id,
      audit_event_id: version.audit_event_id,
      replayed: true,
    });
    expect(hash(await persisted())).toBe(accepted);
    expect(transport.send).not.toHaveBeenCalled();
    await expect(
      service.execute(
        "file_register_upload",
        { ...input, provider: "private_blob" },
        principal,
        options,
      ),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect(hash(await persisted())).toBe(accepted);
    expect(transport.blob.get(oldKey)).toEqual(bytes);
    expect(transport.neon.get(nextKey)).toEqual(nextBytes);
  });

  it("a Neon key cannot be registered using Blob bytes, false checksums, unsupported providers or another owner namespace", async () => {
    const key = storageKey("synthetic-neon-missing");
    transport.blob.set(key, bytes);
    const input = {
      provider: "neon_object_storage",
      storage_key: key,
      title: "Synthetic candidate",
    };
    await expect(
      service.execute("file_register_upload", input, principal, {
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "ENTITY_NOT_FOUND" });
    expect(transport.getBlob).not.toHaveBeenCalled();
    const baseline = hash(await persisted());
    transport.neon.set(key, bytes);
    await expect(
      service.execute(
        "file_register_upload",
        { ...input, sha256: "0".repeat(64) },
        principal,
        { idempotencyKey: randomUUID() },
      ),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      service.execute(
        "file_register_upload",
        { ...input, size_bytes: bytes.length + 1 },
        principal,
        { idempotencyKey: randomUUID() },
      ),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    transport.send.mockClear();
    await expect(
      service.execute(
        "file_register_upload",
        { ...input, provider: "arbitrary_s3" },
        principal,
        { idempotencyKey: randomUUID() },
      ),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      service.execute(
        "file_register_upload",
        {
          ...input,
          storage_key: storageKey("foreign", "synthetic-foreign-owner"),
        },
        principal,
        { idempotencyKey: randomUUID() },
      ),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_PERMISSIONS" });
    expect(transport.send).not.toHaveBeenCalled();
    expect(hash(await persisted())).toBe(baseline);
  });

  it("stale original revision and read-only scopes roll back registration without modifying accepted rows", async () => {
    const key = storageKey("synthetic-neon-accepted");
    transport.neon.set(key, bytes);
    const original = await service.execute(
      "file_register_upload",
      {
        provider: "neon_object_storage",
        storage_key: key,
        title: "Synthetic original",
      },
      principal,
      { idempotencyKey: randomUUID() },
    );
    await service.execute(
      "file_metadata_update",
      {
        file_id: original.entity_id,
        description: "Synthetic owner annotation",
      },
      principal,
      { idempotencyKey: randomUUID(), expectedRevision: original.version },
    );
    const baseline = hash(await persisted());
    const nextKey = storageKey("synthetic-neon-stale-version");
    transport.neon.set(nextKey, Buffer.from("new version"));
    const input = {
      provider: "neon_object_storage",
      storage_key: nextKey,
      file_id: original.entity_id,
    };
    await expect(
      service.execute("file_register_upload", input, principal, {
        idempotencyKey: randomUUID(),
        expectedRevision: original.version,
      }),
    ).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    transport.send.mockClear();
    await expect(
      service.execute(
        "file_register_upload",
        input,
        { ...principal, scopes: ["files:read"] },
        { idempotencyKey: randomUUID(), expectedRevision: 2 },
      ),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_PERMISSIONS" });
    expect(transport.send).not.toHaveBeenCalled();
    expect(hash(await persisted())).toBe(baseline);
  });
});
