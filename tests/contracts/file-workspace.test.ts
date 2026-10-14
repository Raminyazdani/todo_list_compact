import { createHash, randomUUID } from "node:crypto";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  boundedTextDiff,
  loadFilePreview,
  MAX_TEXT_PREVIEW_BYTES,
  prepareBulkArchive,
  previewBytes,
  runBulkArchive,
  versionMetadataDiff,
  type ArchivePreview,
} from "../../features/file-tools";
import { SafeTextPreview } from "../../features/files";
import type { FileDTO, Principal } from "../../shared/contracts";
import type { Database } from "../../server/db/database";
import { createTestDatabase } from "../domain/database";
import { createDomainService } from "../../server/domain/service";
import { ownerStoragePrefix } from "../../server/integrations/storage";
const provider = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn() }));
vi.mock("@vercel/blob", () => ({ get: provider.get, put: provider.put }));
const syntheticFile = (overrides: Partial<FileDTO> = {}): FileDTO => ({
  file_id: "F-synthetic-preview",
  title: "Synthetic preview",
  original_filename: "synthetic.txt",
  provider: "private_blob",
  external_id: null,
  external_url: null,
  state: "Inbox",
  mime_type: "text/plain",
  size_bytes: null,
  sha256: null,
  version_group_id: "V-synthetic",
  revision: 1,
  archived_at: null,
  legacy_metadata: {},
  ...overrides,
});
describe("Safe browser preview adapter with mocked HTTP only; no hosted byte-provider proof", () => {
  it("actual text renderer escapes stored active markup rather than interpreting it", () => {
    const html = renderToStaticMarkup(
      createElement(SafeTextPreview, {
        text: '<script>alert("stored")</script><img src=x onerror=alert(1)>',
      }),
    );
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;img");
  });
  it("Drive originals and HTML/SVG/PDF are rejected before any byte request", async () => {
    const request = vi.fn();
    expect(
      await loadFilePreview(
        syntheticFile({ provider: "google_drive" }),
        request,
      ),
    ).toEqual({ kind: "unavailable", reason: "external" });
    for (const mime_type of ["text/html", "image/svg+xml", "application/pdf"])
      expect(
        await loadFilePreview(syntheticFile({ mime_type }), request),
      ).toEqual({ kind: "unavailable", reason: "unsupported" });
    expect(request).not.toHaveBeenCalled();
  });
  it("32KB UTF8 prefix is explicitly truncated, stream cancelled, and only exact same-origin ACL download is requested", async () => {
    const cancel = vi.fn();
    const bytes = new TextEncoder().encode(
      "x".repeat(MAX_TEXT_PREVIEW_BYTES - 1) + "فارسی",
    );
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(bytes);
        },
        cancel,
      }),
      { headers: { "Content-Type": "text/plain; charset=utf-8" } },
    );
    const request = vi.fn(async () => response);
    const result = await loadFilePreview(
      syntheticFile({ file_id: "F-stable/with spaces" }),
      request,
    );
    expect(result).toMatchObject({ kind: "text", truncated: true });
    if (result.kind !== "text") throw new Error("Expected bounded text");
    expect(new TextEncoder().encode(result.text).length).toBeLessThanOrEqual(
      MAX_TEXT_PREVIEW_BYTES,
    );
    expect(cancel).toHaveBeenCalledOnce();
    expect(request.mock.calls[0]).toMatchObject([
      "/api/v1/files/F-stable%2Fwith%20spaces/download",
      { credentials: "same-origin", cache: "no-store", redirect: "manual" },
    ]);
  });
  it("forged MIME, checksum corruption and denied ACL never become a successful preview", async () => {
    const wrongType = vi.fn(
      async () =>
        new Response("<script>active</script>", {
          headers: { "Content-Type": "text/html" },
        }),
    );
    expect(await loadFilePreview(syntheticFile(), wrongType)).toMatchObject({
      kind: "unavailable",
      reason: "invalid_bytes",
    });
    const corrupted = vi.fn(
      async () =>
        new Response("corrupt", { headers: { "Content-Type": "text/plain" } }),
    );
    expect(
      await loadFilePreview(
        syntheticFile({ sha256: "a".repeat(64) }),
        corrupted,
      ),
    ).toMatchObject({ kind: "unavailable", reason: "invalid_bytes" });
    const denied = vi.fn(
      async () => new Response("private denial", { status: 403 }),
    );
    await expect(loadFilePreview(syntheticFile(), denied)).rejects.toThrow(
      "FILE_PREVIEW_REQUEST_DENIED_403",
    );
  });
  it("raster magic and dimensions are bounded; SVG masquerading as PNG and oversized images fail", () => {
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jpL0AAAAASUVORK5CYII=",
      "base64",
    );
    expect(previewBytes(png, "image/png")).toMatchObject({
      kind: "image",
      width: 1,
      height: 1,
    });
    expect(
      previewBytes(
        new TextEncoder().encode("<svg onload='alert(1)'/>"),
        "image/png",
      ),
    ).toMatchObject({ kind: "unavailable" });
    const bomb = Uint8Array.from(png);
    new DataView(bomb.buffer).setUint32(16, 8192);
    new DataView(bomb.buffer).setUint32(20, 8192);
    expect(previewBytes(bomb, "image/png")).toMatchObject({
      kind: "unavailable",
    });
    expect(previewBytes(png, "image/png", true)).toMatchObject({
      kind: "unavailable",
    });
    expect(
      previewBytes(Uint8Array.from([255, 255]), "text/plain"),
    ).toMatchObject({ kind: "unavailable" });
  });
  it("version diff reports exact metadata and bounded changed lines, never a full-document match beyond the inspected range", () => {
    expect(
      versionMetadataDiff(
        syntheticFile(),
        syntheticFile({ sha256: "b".repeat(64), description: "new" }),
      ).map((diff) => diff.field),
    ).toEqual(["sha256", "description"]);
    expect(boundedTextDiff("same\nbefore", "same\nafter")).toMatchObject({
      lines: [{ line: 2, before: "before", after: "after" }],
      truncated: false,
    });
    const many = Array.from({ length: 1000 }, (_, index) => String(index)).join(
      "\n",
    );
    const diff = boundedTextDiff(many, "changed\n" + many);
    expect(diff.truncated).toBe(true);
    expect(diff.lines.length).toBeLessThanOrEqual(300);
  });
  it("duplicate IDs, selections larger than20 and absent explicit confirmation are rejected before mutation", async () => {
    const read = vi.fn(),
      execute = vi.fn();
    await expect(
      prepareBulkArchive([syntheticFile(), syntheticFile()], read),
    ).rejects.toThrow("EXACT_IDS");
    await expect(
      prepareBulkArchive(
        Array.from({ length: 21 }, (_, index) =>
          syntheticFile({ file_id: "F-" + index }),
        ),
        read,
      ),
    ).rejects.toThrow("EXACT_IDS");
    expect(read).not.toHaveBeenCalled();
    await expect(runBulkArchive([], false, execute, read)).rejects.toThrow(
      "CONFIRMATION",
    );
    expect(execute).not.toHaveBeenCalled();
  });
  it("an accepted receipt followed by denied readback stays recoverable and never becomes a rejected write or all-success claim", async () => {
    const plan = await prepareBulkArchive(
      [syntheticFile()],
      async (file_id) => ({
        file_id,
        eligible: true,
        linked_task_count: 1,
        blocked_by: [],
        reason: null,
        revision: 1,
      }),
    );
    const execute = vi.fn(async () => ({
      operation_id: "OP-synthetic-canonical",
      audit_event_id: "AUD-synthetic",
      entity_id: plan[0].file_id,
      version: 2,
      affected_task_ids: [],
      readiness_changes: [],
      changed_fields: [],
      data: null,
    }));
    const denied = vi.fn(async () => {
      throw Object.assign(
        new Error("Synthetic owner grant revoked during readback"),
        { status: 403, code: "INSUFFICIENT_PERMISSIONS" },
      );
    });
    const partial = await runBulkArchive(plan, true, execute, denied);
    expect(partial[0]).toMatchObject({
      state: "unconfirmed",
      receipt_operation_id: "OP-synthetic-canonical",
    });
    const recovered = await runBulkArchive(
      partial,
      true,
      execute,
      async (file_id) =>
        syntheticFile({
          file_id,
          state: "Old",
          archived_at: "2026-10-14T00:00:00Z",
          revision: 2,
        }),
    );
    expect(recovered[0].state).toBe("succeeded");
    expect(recovered[0].operation_id).toBe(plan[0].operation_id);
  });
});

let database: Database;
beforeAll(async () => {
  database = await createTestDatabase();
}, 30000);
beforeEach(() => {
  vi.stubEnv("BLOB_READ_WRITE_TOKEN", "synthetic-provider-contract-token");
  provider.get.mockReset();
  provider.put.mockReset();
  provider.get.mockImplementation(async () => ({
    statusCode: 200,
    stream: new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("original"));
        controller.close();
      },
    }),
  }));
});
afterEach(() => vi.unstubAllEnvs());
afterAll(async () => {
  await database?.close?.();
});
describe("Bulk archive against actual PostgreSQL canonical writes with explicitly mocked Blob readback", () => {
  it("lost accepted acknowledgement is recovered with the same key, other success stays verified, blocked external source stays unchanged, and audit is exactly once", async () => {
    const principal: Principal = {
      ownerId: "synthetic-bulk-" + randomUUID(),
      actorId: "synthetic-owner",
      channel: "UI",
      scopes: ["admin:manage"],
    };
    const service = createDomainService(database);
    const privateFile = async () => {
      const key =
        ownerStoragePrefix(principal.ownerId) +
        createHash("sha256").update(randomUUID()).digest("hex") +
        "/original";
      const registered = await service.execute(
        "file_register_upload",
        {
          title: "Synthetic private original",
          original_filename: "original.txt",
          mime_type: "text/plain",
          storage_key: key,
        },
        principal,
        { idempotencyKey: randomUUID() },
      );
      const created = await service.execute(
        "task_create",
        { title: "Synthetic completed linked task" },
        principal,
        { idempotencyKey: randomUUID() },
      );
      await service.execute(
        "task_complete",
        { task_id: created.entity_id },
        principal,
        { idempotencyKey: randomUUID(), expectedRevision: created.version },
      );
      await service.execute(
        "file_link_to_task",
        { file_id: registered.entity_id, task_id: created.entity_id },
        principal,
        { idempotencyKey: randomUUID() },
      );
      return service.query(
        "file_get_metadata",
        { file_id: registered.entity_id },
        principal,
      ) as Promise<FileDTO>;
    };
    const first = await privateFile(),
      second = await privateFile();
    const external = await service.execute(
      "file_register_external_link",
      {
        title: "Synthetic protected reference",
        external_url:
          "https://drive.google.com/file/d/synthetic-bulk-original/view",
      },
      principal,
      { idempotencyKey: randomUUID() },
    );
    const reference = (await service.query(
      "file_get_metadata",
      { file_id: external.entity_id },
      principal,
    )) as FileDTO;
    const plan = await prepareBulkArchive(
      [first, second, reference],
      (file_id) =>
        service.query(
          "file_archive_preview",
          { file_id },
          principal,
        ) as Promise<ArchivePreview>,
    );
    expect(plan[2]).toMatchObject({
      state: "blocked",
      message: "EXTERNALLY_MANAGED",
    });
    let lost = false;
    const execute = vi.fn(async (row: (typeof plan)[number]) => {
      const result = await service.execute(
        "file_archive",
        { file_id: row.file_id, explicit_user_intent: true },
        principal,
        {
          idempotencyKey: row.operation_id,
          expectedRevision: row.preview!.revision,
        },
      );
      if (!lost && row.file_id === first.file_id) {
        lost = true;
        throw new Error("Synthetic response lost after accepted transaction");
      }
      return result;
    });
    const read = (file_id: string) =>
      service.query(
        "file_get_metadata",
        { file_id },
        principal,
      ) as Promise<FileDTO>;
    const partial = await runBulkArchive(plan, true, execute, read);
    expect(partial.map((row) => row.state)).toEqual([
      "unconfirmed",
      "succeeded",
      "blocked",
    ]);
    expect(execute).toHaveBeenCalledTimes(2);
    const recovered = await runBulkArchive(partial, true, execute, read);
    expect(recovered.map((row) => row.state)).toEqual([
      "succeeded",
      "succeeded",
      "blocked",
    ]);
    expect(execute).toHaveBeenCalledTimes(3);
    expect(execute.mock.calls[2][0].operation_id).toBe(plan[0].operation_id);
    expect((await read(first.file_id)).revision).toBe(first.revision + 1);
    expect(await read(reference.file_id)).toMatchObject({
      provider: "google_drive",
      state: "External",
      revision: reference.revision,
    });
    expect(
      (
        await database.query<{ count: number }>(
          "SELECT count(*)::int count FROM activity_events e JOIN idempotency_operations i ON i.owner_id=e.owner_id AND e.operation_id=i.result->>'operation_id' WHERE e.owner_id=$1 AND i.idempotency_key=$2",
          [principal.ownerId, plan[0].operation_id],
        )
      ).rows[0].count,
    ).toBe(1);
    expect(provider.put).not.toHaveBeenCalled();
    expect(provider.get).toHaveBeenCalled();
  }, 30000);
});
