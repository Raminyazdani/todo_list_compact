import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { Principal } from "../../shared/contracts";
const mock = vi.hoisted(() => ({
  bytes: new Map<string, Uint8Array>(),
  put: vi.fn(),
  get: vi.fn(),
}));
vi.mock("@vercel/blob", () => ({ get: mock.get, put: mock.put }));
import {
  archiveEligibility,
  attachmentHeaders,
  readPrivateFile,
  uploadPrivateFile,
  validateUpload,
  verifyPrivateFileMetadata,
} from "../../server/integrations/storage";
const principal: Principal = {
  ownerId: "synthetic-owner",
  actorId: "synthetic-owner",
  channel: "UI",
  scopes: ["files:read", "files:write"],
};
beforeEach(() => {
  mock.bytes.clear();
  mock.get.mockReset();
  mock.put.mockReset();
  vi.stubEnv("BLOB_READ_WRITE_TOKEN", "synthetic-test-token");
  vi.stubEnv("PRIVATE_STORAGE_PROVIDER", "");
  mock.get.mockImplementation(async (key: string) => {
    const bytes = mock.bytes.get(key);
    return bytes
      ? {
          statusCode: 200,
          stream: new ReadableStream({
            start(controller) {
              controller.enqueue(bytes);
              controller.close();
            },
          }),
        }
      : null;
  });
  mock.put.mockImplementation(
    async (
      key: string,
      bytes: Uint8Array,
      options: { access: string; allowOverwrite: boolean },
    ) => {
      expect(options.access).toBe("private");
      expect(options.allowOverwrite).toBe(false);
      if (mock.bytes.has(key)) throw Error("Original is immutable");
      mock.bytes.set(key, new Uint8Array(bytes));
      return { pathname: key };
    },
  );
});
afterEach(() => vi.unstubAllEnvs());
describe("private byte storage boundaries", () => {
  it("fails closed without private token and never calls a storage API", async () => {
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "");
    await expect(
      uploadPrivateFile(
        Buffer.from("original"),
        "synthetic.txt",
        "text/plain",
        principal,
        "synthetic-operation",
      ),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_OPERATION" });
    expect(mock.put).not.toHaveBeenCalled();
    expect(mock.get).not.toHaveBeenCalled();
  });
  it("validates actual signature and rejects traversal/active HTML", () => {
    expect(() =>
      validateUpload(
        Buffer.from("not a PDF"),
        "synthetic.pdf",
        "application/pdf",
      ),
    ).toThrow(/signature/);
    expect(() =>
      validateUpload(Buffer.from("hello"), "../file.txt", "text/plain"),
    ).toThrow();
    expect(() =>
      validateUpload(
        Buffer.from("<script>x</script>"),
        "active.html",
        "text/html",
      ),
    ).toThrow();
  });
  it("verifies exact original bytes, replay idempotence and distinct version preservation", async () => {
    const original = Buffer.from("original\nمتن"),
      result = await uploadPrivateFile(
        original,
        "same-name.txt",
        "text/plain",
        principal,
        "synthetic-operation-v1",
      );
    expect(result.size_bytes).toBe(original.length);
    expect(result.sha256).toHaveLength(64);
    expect(
      await verifyPrivateFileMetadata(result.storage_key, principal),
    ).toEqual({ size_bytes: original.length, sha256: result.sha256 });
    const stream = await readPrivateFile(result.storage_key, principal);
    expect(Buffer.from(await new Response(stream).arrayBuffer())).toEqual(
      original,
    );
    expect(
      (
        await uploadPrivateFile(
          original,
          "same-name.txt",
          "text/plain",
          principal,
          "synthetic-operation-v1",
        )
      ).storage_key,
    ).toBe(result.storage_key);
    expect(mock.put).toHaveBeenCalledTimes(1);
    const second = await uploadPrivateFile(
      Buffer.from("changed version"),
      "same-name.txt",
      "text/plain",
      principal,
      "synthetic-operation-v2",
    );
    expect(second.storage_key).not.toBe(result.storage_key);
    expect(mock.bytes.size).toBe(2);
  });
  it("same operation cannot overwrite a different payload", async () => {
    await uploadPrivateFile(
      Buffer.from("original"),
      "file.txt",
      "text/plain",
      principal,
      "synthetic-operation",
    );
    await expect(
      uploadPrivateFile(
        Buffer.from("changed"),
        "file.txt",
        "text/plain",
        principal,
        "synthetic-operation",
      ),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect(mock.put).toHaveBeenCalledTimes(1);
  });
  it("unauthorized owner namespace rejects before private download", async () => {
    const file = await uploadPrivateFile(
      Buffer.from("private"),
      "file.txt",
      "text/plain",
      principal,
      "synthetic-operation",
    );
    mock.get.mockClear();
    await expect(
      readPrivateFile(file.storage_key, {
        ...principal,
        ownerId: "other-owner",
      }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_PERMISSIONS" });
    expect(mock.get).not.toHaveBeenCalled();
  });
  it("corrupted read-back cannot become a successful registered upload", async () => {
    mock.get.mockResolvedValueOnce(null).mockResolvedValueOnce({
      statusCode: 200,
      stream: new ReadableStream({
        start(c) {
          c.enqueue(Buffer.from("corrupted"));
          c.close();
        },
      }),
    });
    await expect(
      uploadPrivateFile(
        Buffer.from("original"),
        "file.txt",
        "text/plain",
        principal,
        "synthetic-operation",
      ),
    ).rejects.toThrow(/checksum/);
  });
  it("archive requires all existing active task links closed and never moves External/System", () => {
    const file = { state: "Inbox", provider: "google_drive" },
      links = [
        { active: true, task_id: "T-one" },
        { active: true, task_id: "T-two" },
      ];
    expect(
      archiveEligibility(file, links, [
        { task_id: "T-one", status: "Done" },
        { task_id: "T-two", status: "Next" },
      ]).eligible,
    ).toBe(false);
    expect(
      archiveEligibility(file, links, [{ task_id: "T-one", status: "Done" }])
        .reason,
    ).toBe("missing_linked_task");
    const tasks = [
      { task_id: "T-one", status: "Done" },
      { task_id: "T-two", status: "Cancelled" },
    ];
    expect(archiveEligibility(file, links, tasks).eligible).toBe(true);
    expect(
      archiveEligibility({ ...file, state: "External" }, links, tasks).eligible,
    ).toBe(false);
    expect(
      archiveEligibility({ ...file, protected: true }, links, tasks).eligible,
    ).toBe(false);
    expect(archiveEligibility(file, [], tasks).eligible).toBe(false);
  });
  it("download headers contain attachment and private no-store rather than active inline content", () => {
    const headers = attachmentHeaders("safe.txt", "text/html");
    expect(headers["Content-Disposition"]).toContain("attachment");
    expect(headers["Content-Type"]).toBe("application/octet-stream");
    expect(headers["Cache-Control"]).toBe("private, no-store");
  });
});
