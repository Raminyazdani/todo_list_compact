import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decryptBackup, encryptBackup } from "../../server/integrations/backup";
import { hash } from "../../server/domain/core";
import { BACKUP_TABLES } from "../../server/domain/migration";
const mocks = vi.hoisted(() => ({
  db: vi.fn(),
  domain: vi.fn(),
  get: vi.fn(),
  put: vi.fn(),
}));
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
  vi.stubEnv("BACKUP_ENCRYPTION_KEY", passphrase);
  mocks.db.mockReset().mockResolvedValue({ rows: [], rowCount: 1 });
  mocks.domain.mockReset().mockResolvedValue(backup);
  mocks.get.mockReset();
  mocks.put.mockReset().mockResolvedValue({ pathname: "synthetic-stored-key" });
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
