import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { decryptBackup, encryptBackup } from "../../server/integrations/backup";
import { hash } from "../../server/domain/core";
import { BACKUP_TABLES } from "../../server/domain/migration";
const mocks = vi.hoisted(() => ({
  db: vi.fn(),
  domain: vi.fn(),
  get: vi.fn(),
  put: vi.fn(),
  neonSend: vi.fn(),
  neonDestroy: vi.fn(),
}));
vi.mock("@aws-sdk/client-s3", async (original) => {
  const sdk = await original<typeof import("@aws-sdk/client-s3")>();
  return {
    ...sdk,
    S3Client: class {
      send = mocks.neonSend;
      destroy = mocks.neonDestroy;
    },
  };
});
vi.mock("@vercel/blob", () => ({ get: mocks.get, put: mocks.put }));
vi.mock("../../server/db/database", () => ({
  getDatabase: () => ({ query: mocks.db }),
}));
vi.mock("../../server/domain/service", () => ({
  getDomainService: () => ({ query: mocks.domain }),
}));
import { runEncryptedBackup } from "../../server/jobs/backup";
const owner = "synthetic-backup-owner",
  passphrase = "synthetic-strong-encryption-passphrase";
const tables = {
  ...Object.fromEntries(BACKUP_TABLES.map((table) => [table, []])),
  tasks: [
    {
      owner_id: owner,
      task_id: "synthetic-task",
      title: "Private synthetic original text",
    },
  ],
};
const checksums = Object.fromEntries(
  Object.entries(tables).map(([table, rows]) => [table, hash(rows)]),
);
const backup = {
  format: "ramin-life-os/1",
  schema_version: 1,
  owner_id: owner,
  exported_at: "2026-10-13T21:00:00Z",
  tables,
  checksums,
  manifest_hash: hash(checksums),
};
const providerObject = (bytes: Uint8Array) => ({
  statusCode: 200,
  stream: new Response(new Uint8Array(bytes)).body!,
});
beforeEach(() => {
  vi.stubEnv("BLOB_READ_WRITE_TOKEN", "synthetic-private-provider-token");
  vi.stubEnv("PRIVATE_STORAGE_PROVIDER", "");
  vi.stubEnv("BACKUP_ENCRYPTION_KEY", passphrase);
  mocks.db.mockReset().mockResolvedValue({ rows: [], rowCount: 1 });
  mocks.domain.mockReset().mockResolvedValue(backup);
  mocks.get.mockReset();
  mocks.put.mockReset().mockResolvedValue({ pathname: "synthetic-stored-key" });
  mocks.neonSend.mockReset();
  mocks.neonDestroy.mockReset();
});

const configureNeon = () => {
  vi.stubEnv("PRIVATE_STORAGE_PROVIDER", "neon_object_storage");
  vi.stubEnv(
    "NEON_STORAGE_ENDPOINT_URL_S3",
    "https://synthetic.storage.neon.tech",
  );
  vi.stubEnv("NEON_STORAGE_REGION", "eu-central-1");
  vi.stubEnv("NEON_STORAGE_BUCKET", "synthetic-private-backups");
  vi.stubEnv("NEON_STORAGE_ACCESS_KEY_ID", "synthetic-access-key");
  vi.stubEnv("NEON_STORAGE_SECRET_ACCESS_KEY", "synthetic-secret-key");
  // Synthetic transport assertion only; activation needs an actual operator proof.
  vi.stubEnv("NEON_STORAGE_IMMUTABLE_PUT_VERIFIED", "true");
};
const neonObject = (bytes: Uint8Array) => ({
  Body: new Response(new Uint8Array(bytes)).body!,
  ContentLength: bytes.byteLength,
});

describe("encrypted Neon backups with mocked S3 transport, not live storage proof", () => {
  it.each(["private_blob", "neon_object_storage"])(
    "records provider provenance for disconnected and failed backups (%s)",
    async (provider) => {
      if (provider === "neon_object_storage") {
        configureNeon();
        vi.stubEnv("NEON_STORAGE_IMMUTABLE_PUT_VERIFIED", "false");
      } else vi.stubEnv("BLOB_READ_WRITE_TOKEN", "");
      const disconnected = await runEncryptedBackup(owner, "2026-10-13");
      expect(disconnected).toMatchObject({
        status: "disconnected",
        verified: false,
      });
      const first = mocks.db.mock.calls.find(([sql]) =>
        sql.includes("'disconnected'"),
      );
      if (!first) throw Error("Expected disconnected provenance receipt");
      expect(first[0]).toContain("storage_key=$3");
      const key = first[1][2];
      expect(key).toMatch(
        provider === "neon_object_storage"
          ? /^owners\/[a-f0-9]{64}\/backups\/2026-10-13\.json$/
          : /^life-os-backups\/[a-f0-9]{32}\/2026-10-13\.json$/,
      );
      expect(key).not.toContain(owner);
      mocks.db.mockClear();
      if (provider === "neon_object_storage") {
        vi.stubEnv("NEON_STORAGE_IMMUTABLE_PUT_VERIFIED", "true");
        mocks.neonSend.mockRejectedValue(
          new Error("synthetic provider failure"),
        );
      } else {
        vi.stubEnv("BLOB_READ_WRITE_TOKEN", "synthetic-private-token");
        mocks.get.mockRejectedValue(new Error("synthetic provider failure"));
      }
      const failed = await runEncryptedBackup(owner, "2026-10-13");
      expect(failed).toMatchObject({ status: "failed", verified: false });
      expect(failed.backup_id).toBe(disconnected.backup_id);
      const failure = mocks.db.mock.calls.find(([sql]) =>
        sql.includes("'failed'"),
      );
      if (!failure) throw Error("Expected failed provenance receipt");
      expect(failure[0]).toContain("storage_key=$3");
      expect(failure[1][2]).toBe(key);
      expect(recordedStatus("verified")).toBe(false);
      expect(mocks.domain).not.toHaveBeenCalled();
    },
  );
  it("requires the immutable PUT gate and cannot silently use the configured legacy Blob", async () => {
    configureNeon();
    vi.stubEnv("NEON_STORAGE_IMMUTABLE_PUT_VERIFIED", "false");
    expect(await runEncryptedBackup(owner, "2026-10-13")).toMatchObject({
      status: "disconnected",
      verified: false,
    });
    expect(mocks.neonSend).not.toHaveBeenCalled();
    expect(mocks.put).not.toHaveBeenCalled();
    expect(mocks.get).not.toHaveBeenCalled();
    expect(mocks.domain).not.toHaveBeenCalled();
  });

  it("uses a distinct private owner backup namespace and verifies real ciphertext/manifest", async () => {
    configureNeon();
    let stored: Uint8Array | undefined;
    mocks.neonSend.mockImplementation(async (command) => {
      if (command instanceof GetObjectCommand) {
        if (!stored) throw { $metadata: { httpStatusCode: 404 } };
        return neonObject(stored);
      }
      expect(command).toBeInstanceOf(PutObjectCommand);
      expect(command.input).toMatchObject({
        IfNoneMatch: "*",
        ContentType: "application/json",
        CacheControl: "private, no-store",
      });
      stored = new Uint8Array(command.input.Body);
      return {};
    });
    expect(await runEncryptedBackup(owner, "2026-10-13")).toMatchObject({
      status: "verified",
      verified: true,
      manifest_hash: backup.manifest_hash,
    });
    const commands = mocks.neonSend.mock.calls.map(([command]) => command);
    const put = commands.find((command) => command instanceof PutObjectCommand);
    if (!put) throw new Error("Expected a synthetic private PUT");
    expect(put.input.Key).toMatch(
      /^owners\/[a-f0-9]{64}\/backups\/2026-10-13\.json$/,
    );
    expect(put.input.Key).not.toContain(owner);
    expect(put.input.Key).not.toContain("/files/");
    expect(Buffer.from(stored!).toString()).not.toContain(
      tables.tasks[0].title,
    );
    expect(
      await decryptBackup(
        JSON.parse(Buffer.from(stored!).toString()),
        passphrase,
      ),
    ).toEqual(backup);
    expect(recordedStatus("verified")).toBe(true);
    expect(mocks.get).not.toHaveBeenCalled();
    expect(mocks.put).not.toHaveBeenCalled();
  });

  it("reconciles an accepted Neon write with a lost response without a second PUT or export", async () => {
    configureNeon();
    let stored: Uint8Array | undefined;
    mocks.neonSend.mockImplementation(async (command) => {
      if (command instanceof GetObjectCommand) {
        if (!stored) throw { $metadata: { httpStatusCode: 404 } };
        return neonObject(stored);
      }
      stored = new Uint8Array(command.input.Body);
      throw new Error("Synthetic accepted response lost");
    });
    const first = await runEncryptedBackup(owner, "2026-10-13");
    expect(first).toMatchObject({ status: "failed", verified: false });
    const second = await runEncryptedBackup(owner, "2026-10-13");
    expect(second).toMatchObject({ status: "verified", verified: true });
    expect(first.backup_id).toBe(second.backup_id);
    expect(
      mocks.neonSend.mock.calls.filter(
        ([command]) => command instanceof PutObjectCommand,
      ),
    ).toHaveLength(1);
    expect(mocks.domain).toHaveBeenCalledTimes(1);
  });

  it("a verified legacy Blob receipt cannot satisfy a new Neon backup on the same day", async () => {
    mocks.get.mockResolvedValue(
      providerObject(
        Buffer.from(JSON.stringify(await encryptBackup(backup, passphrase))),
      ),
    );
    const legacy = await runEncryptedBackup(owner, "2026-10-13");
    configureNeon();
    mocks.db.mockImplementation(async (sql, args) => ({
      rows:
        sql.startsWith("SELECT") && args[1] === legacy.backup_id
          ? [{ status: "verified" }]
          : [],
      rowCount: 1,
    }));
    mocks.neonSend.mockResolvedValue(
      neonObject(
        Buffer.from(JSON.stringify(await encryptBackup(backup, passphrase))),
      ),
    );
    const neon = await runEncryptedBackup(owner, "2026-10-13");
    expect(neon.backup_id).not.toBe(legacy.backup_id);
    expect(neon).toMatchObject({ status: "verified", verified: true });
    expect(neon).not.toHaveProperty("replayed");
    expect(mocks.neonSend).toHaveBeenCalledTimes(1);
  });

  it("rejects another owner's authenticated ciphertext without writing or recording verification", async () => {
    configureNeon();
    mocks.neonSend.mockResolvedValue(
      neonObject(
        Buffer.from(
          JSON.stringify(
            await encryptBackup(
              { ...backup, owner_id: "synthetic-other-owner" },
              passphrase,
            ),
          ),
        ),
      ),
    );
    expect(await runEncryptedBackup(owner, "2026-10-13")).toMatchObject({
      status: "failed",
      verified: false,
    });
    expect(recordedStatus("verified")).toBe(false);
    expect(
      mocks.neonSend.mock.calls.every(
        ([command]) => command instanceof GetObjectCommand,
      ),
    ).toBe(true);
    expect(mocks.domain).not.toHaveBeenCalled();
  });

  it("bounds provider backup body size before decryption or canonical export", async () => {
    configureNeon();
    const cancel = vi.fn();
    mocks.neonSend.mockResolvedValue({
      ContentLength: 70 * 1024 * 1024 + 1,
      Body: new ReadableStream({ cancel }),
    });
    expect(await runEncryptedBackup(owner, "2026-10-13")).toMatchObject({
      status: "failed",
      verified: false,
    });
    expect(cancel).toHaveBeenCalled();
    expect(mocks.neonDestroy).toHaveBeenCalled();
    expect(mocks.domain).not.toHaveBeenCalled();
    expect(recordedStatus("verified")).toBe(false);
  });
});
afterEach(() => {
  vi.unstubAllEnvs();
});
const recordedStatus = (status: string) =>
  mocks.db.mock.calls.some(([sql]) => sql.includes("'" + status + "'"));
describe("scheduled private backup contract with mocked database/domain/Blob and real AES-GCM", () => {
  it("missing configuration is disconnected and cannot invoke provider or fabricate verified state", async () => {
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "");
    vi.stubEnv("BACKUP_ENCRYPTION_KEY", "");
    expect(await runEncryptedBackup(owner, "2026-10-13")).toMatchObject({
      status: "disconnected",
      verified: false,
    });
    expect(mocks.get).not.toHaveBeenCalled();
    expect(mocks.put).not.toHaveBeenCalled();
    expect(mocks.domain).not.toHaveBeenCalled();
    expect(recordedStatus("disconnected")).toBe(true);
    expect(recordedStatus("verified")).toBe(false);
  });
  it("a private immutable put followed by authenticated owner/manifest readback is verified", async () => {
    let accepted: Uint8Array | undefined;
    mocks.get.mockImplementation(async () =>
      accepted ? providerObject(accepted) : null,
    );
    mocks.put.mockImplementation(async (_key: string, bytes: Uint8Array) => {
      accepted = Buffer.from(bytes);
      return { pathname: "synthetic-stored-key" };
    });
    const result = await runEncryptedBackup(owner, "2026-10-13");
    expect(result).toMatchObject({
      status: "verified",
      verified: true,
      manifest_hash: backup.manifest_hash,
    });
    expect(recordedStatus("verified")).toBe(true);
    const [key, bytes, options] = mocks.put.mock.calls[0];
    expect(key).toMatch(/^life-os-backups\/[0-9a-f]{32}\/2026-10-13\.json$/);
    expect(key).not.toContain(owner);
    expect(options).toMatchObject({
      access: "private",
      addRandomSuffix: false,
      allowOverwrite: false,
    });
    expect(Buffer.from(bytes).toString()).not.toContain(
      "Private synthetic original text",
    );
    expect(
      await decryptBackup(
        JSON.parse(Buffer.from(bytes).toString()),
        passphrase,
      ),
    ).toEqual(backup);
    expect(mocks.domain).toHaveBeenCalledWith(
      "backup_export",
      {},
      expect.objectContaining({
        ownerId: owner,
        channel: "system",
        scopes: expect.arrayContaining(["backup:export"]),
      }),
    );
  });
  it("corrupt authenticated bytes and valid bytes for another owner fail without verified records", async () => {
    const wrongOwner = Buffer.from(
      JSON.stringify(
        await encryptBackup(
          { ...backup, owner_id: "synthetic-other-owner" },
          passphrase,
        ),
      ),
    );
    const corrupt = await encryptBackup(backup, passphrase);
    corrupt.tag = Buffer.alloc(16).toString("base64");
    for (const bytes of [wrongOwner, Buffer.from(JSON.stringify(corrupt))]) {
      mocks.db.mockClear();
      mocks.get.mockResolvedValue(providerObject(bytes));
      expect(await runEncryptedBackup(owner, "2026-10-13")).toMatchObject({
        status: "failed",
        verified: false,
        error_code: "PRIVATE_BACKUP_FAILED",
      });
      expect(recordedStatus("verified")).toBe(false);
      expect(recordedStatus("failed")).toBe(true);
    }
    expect(mocks.put).not.toHaveBeenCalled();
  });
  it("fresh readback with a changed manifest is rejected even with valid encryption", async () => {
    mocks.get
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(
        providerObject(
          Buffer.from(
            JSON.stringify(
              await encryptBackup(
                { ...backup, manifest_hash: "synthetic-wrong-manifest" },
                passphrase,
              ),
            ),
          ),
        ),
      );
    expect(await runEncryptedBackup(owner, "2026-10-13")).toMatchObject({
      status: "failed",
      verified: false,
    });
    expect(recordedStatus("verified")).toBe(false);
  });
  it("existing authenticated ciphertext cannot be marked verified with inconsistent table checksums", async () => {
    const inconsistent = {
      ...backup,
      tables: {
        ...tables,
        tasks: [
          {
            ...tables.tasks[0],
            title: "Synthetic changed table with unchanged checksum",
          },
        ],
      },
    };
    mocks.get.mockResolvedValue(
      providerObject(
        Buffer.from(
          JSON.stringify(await encryptBackup(inconsistent, passphrase)),
        ),
      ),
    );
    expect(await runEncryptedBackup(owner, "2026-10-13")).toMatchObject({
      status: "failed",
      verified: false,
    });
    expect(recordedStatus("verified")).toBe(false);
    expect(mocks.put).not.toHaveBeenCalled();
  });
  it("an uncertain accepted put is salvaged on the same immutable key without overwrite or new export", async () => {
    let accepted: Uint8Array | undefined;
    mocks.get.mockImplementation(async () =>
      accepted ? providerObject(accepted) : null,
    );
    mocks.put.mockImplementation(async (_key: string, bytes: Uint8Array) => {
      accepted = Buffer.from(bytes);
      throw new Error("Synthetic accepted transport response lost");
    });
    const first = await runEncryptedBackup(owner, "2026-10-13");
    expect(first).toMatchObject({ status: "failed", verified: false });
    expect(recordedStatus("verified")).toBe(false);
    const second = await runEncryptedBackup(owner, "2026-10-13");
    expect(second).toMatchObject({
      status: "verified",
      verified: true,
      manifest_hash: backup.manifest_hash,
    });
    expect(first.backup_id).toBe(second.backup_id);
    expect(mocks.put).toHaveBeenCalledTimes(1);
    expect(mocks.domain).toHaveBeenCalledTimes(1);
    expect(new Set(mocks.get.mock.calls.map(([key]) => key)).size).toBe(1);
    expect(recordedStatus("verified")).toBe(true);
  });
});
