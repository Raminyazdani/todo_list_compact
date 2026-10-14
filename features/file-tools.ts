import type { FileDTO, MutationResult } from "../shared/contracts";

export const MAX_TEXT_PREVIEW_BYTES = 32 * 1024;
const MAX_IMAGE_PREVIEW_BYTES = 4 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 16_000_000;
export type SafePreview =
  | { kind: "text"; text: string; truncated: boolean }
  | {
      kind: "image";
      bytes: Uint8Array;
      mime_type: "image/png" | "image/jpeg" | "image/webp";
      width: number;
      height: number;
    }
  | {
      kind: "unavailable";
      reason: "external" | "unsupported" | "invalid_bytes";
    };

function imageDimensions(
  bytes: Uint8Array,
  mime: string,
): [number, number] | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ascii = (start: number, end: number) =>
    String.fromCharCode(...bytes.subarray(start, end));
  if (
    mime === "image/png" &&
    bytes.length >= 33 &&
    [137, 80, 78, 71, 13, 10, 26, 10].every(
      (byte, index) => bytes[index] === byte,
    ) &&
    view.getUint32(8) === 13 &&
    ascii(12, 16) === "IHDR"
  )
    return [view.getUint32(16), view.getUint32(20)];
  if (
    mime === "image/jpeg" &&
    bytes.length >= 4 &&
    bytes[0] === 255 &&
    bytes[1] === 216
  ) {
    let offset = 2;
    while (offset + 4 <= bytes.length && offset < MAX_TEXT_PREVIEW_BYTES) {
      if (bytes[offset] !== 255) return null;
      while (bytes[offset] === 255) offset++;
      const marker = bytes[offset++];
      if (marker === 217 || marker === 218) return null;
      if (marker === 1 || (marker >= 208 && marker <= 215)) continue;
      if (offset + 2 > bytes.length) return null;
      const length = view.getUint16(offset);
      if (length < 2 || offset + length > bytes.length) return null;
      if ([192, 193, 194].includes(marker) && length >= 8)
        return [view.getUint16(offset + 5), view.getUint16(offset + 3)];
      offset += length;
    }
  }
  if (
    mime === "image/webp" &&
    bytes.length >= 30 &&
    ascii(0, 4) === "RIFF" &&
    ascii(8, 12) === "WEBP" &&
    view.getUint32(4, true) + 8 === bytes.length
  ) {
    if (ascii(12, 16) === "VP8X")
      return [
        1 + bytes[24] + (bytes[25] << 8) + (bytes[26] << 16),
        1 + bytes[27] + (bytes[28] << 8) + (bytes[29] << 16),
      ];
    if (
      ascii(12, 16) === "VP8 " &&
      bytes[23] === 157 &&
      bytes[24] === 1 &&
      bytes[25] === 42
    )
      return [
        view.getUint16(26, true) & 0x3fff,
        view.getUint16(28, true) & 0x3fff,
      ];
    if (ascii(12, 16) === "VP8L" && bytes[20] === 47)
      return [
        1 + bytes[21] + ((bytes[22] & 63) << 8),
        1 +
          ((bytes[22] & 192) >> 6) +
          (bytes[23] << 2) +
          ((bytes[24] & 15) << 10),
      ];
  }
  return null;
}
/** Only inert plaintext or bounded raster signatures may enter an in-app preview. */
export function previewBytes(
  bytes: Uint8Array,
  mime: string,
  truncated = false,
): SafePreview {
  if (mime === "text/plain") {
    if (bytes.length > MAX_TEXT_PREVIEW_BYTES || bytes.includes(0))
      return { kind: "unavailable", reason: "invalid_bytes" };
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes, {
        stream: truncated,
      });
      return { kind: "text", text, truncated };
    } catch {
      return { kind: "unavailable", reason: "invalid_bytes" };
    }
  }
  if (!["image/png", "image/jpeg", "image/webp"].includes(mime))
    return { kind: "unavailable", reason: "unsupported" };
  if (truncated || bytes.length > MAX_IMAGE_PREVIEW_BYTES)
    return { kind: "unavailable", reason: "invalid_bytes" };
  const dimensions = imageDimensions(bytes, mime);
  if (
    !dimensions ||
    dimensions.some((value) => value < 1 || value > 8192) ||
    dimensions[0] * dimensions[1] > MAX_IMAGE_PIXELS
  )
    return { kind: "unavailable", reason: "invalid_bytes" };
  return {
    kind: "image",
    bytes,
    mime_type: mime as "image/png" | "image/jpeg" | "image/webp",
    width: dimensions[0],
    height: dimensions[1],
  };
}
async function boundedBytes(response: Response, maximum: number) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("FILE_PREVIEW_BYTES_MISSING");
  const chunks: Uint8Array[] = [];
  let length = 0,
    truncated = false;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      const remaining = maximum - length;
      chunks.push(part.value.slice(0, remaining));
      length += Math.min(remaining, part.value.length);
      if (part.value.length > remaining) {
        truncated = true;
        await reader.cancel();
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const part of chunks) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return { bytes, truncated };
}
/** Never follow a Drive redirect or fetch a raw storage URL/token in the browser. */
export async function loadFilePreview(
  file: FileDTO,
  request: typeof fetch = fetch,
): Promise<SafePreview> {
  if (file.provider !== "private_blob")
    return { kind: "unavailable", reason: "external" };
  const mime = file.mime_type.split(";")[0].trim().toLowerCase();
  if (!["text/plain", "image/png", "image/jpeg", "image/webp"].includes(mime))
    return { kind: "unavailable", reason: "unsupported" };
  const response = await request(
    `/api/v1/files/${encodeURIComponent(file.file_id)}/download`,
    {
      cache: "no-store",
      credentials: "same-origin",
      redirect: "manual",
      signal: AbortSignal.timeout(15000),
    },
  );
  if (!response.ok)
    throw new Error(`FILE_PREVIEW_REQUEST_DENIED_${response.status}`);
  if (
    response.redirected ||
    response.headers.get("Content-Type")?.split(";")[0].trim().toLowerCase() !==
      mime
  )
    return { kind: "unavailable", reason: "invalid_bytes" };
  const { bytes, truncated } = await boundedBytes(
    response,
    mime === "text/plain" ? MAX_TEXT_PREVIEW_BYTES : MAX_IMAGE_PREVIEW_BYTES,
  );
  if (!truncated && file.sha256) {
    const hash = Array.from(
      new Uint8Array(
        await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes)),
      ),
    )
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    if (hash !== file.sha256.toLowerCase())
      return { kind: "unavailable", reason: "invalid_bytes" };
  }
  return previewBytes(bytes, mime, truncated);
}

export function versionMetadataDiff(left: FileDTO, right: FileDTO) {
  const fields = [
    "title",
    "original_filename",
    "mime_type",
    "size_bytes",
    "sha256",
    "state",
    "description",
    "tags",
  ] as const;
  return fields
    .filter(
      (field) =>
        JSON.stringify(left[field] ?? null) !==
        JSON.stringify(right[field] ?? null),
    )
    .map((field) => ({
      field,
      before: JSON.stringify(left[field] ?? null).slice(
        0,
        MAX_TEXT_PREVIEW_BYTES,
      ),
      after: JSON.stringify(right[field] ?? null).slice(
        0,
        MAX_TEXT_PREVIEW_BYTES,
      ),
    }));
}
export function boundedTextDiff(left: string, right: string) {
  const allLeft = left.slice(0, MAX_TEXT_PREVIEW_BYTES).split("\n"),
    allRight = right.slice(0, MAX_TEXT_PREVIEW_BYTES).split("\n");
  const lines = [];
  for (
    let index = 0;
    index < Math.min(Math.max(allLeft.length, allRight.length), 300);
    index++
  )
    if (allLeft[index] !== allRight[index])
      lines.push({
        line: index + 1,
        before: allLeft[index] ?? "",
        after: allRight[index] ?? "",
      });
  return {
    lines,
    truncated:
      allLeft.length > 300 ||
      allRight.length > 300 ||
      left.length > MAX_TEXT_PREVIEW_BYTES ||
      right.length > MAX_TEXT_PREVIEW_BYTES,
  };
}
export interface ArchivePreview {
  file_id: string;
  eligible: boolean;
  linked_task_count: number;
  blocked_by: string[];
  reason: string | null;
  revision: number;
}
export interface BulkArchiveRow {
  file_id: string;
  title: string;
  operation_id: string;
  receipt_operation_id?: string;
  receipt_audit_event_id?: string;
  preview: ArchivePreview | null;
  state: "ready" | "blocked" | "succeeded" | "unconfirmed" | "failed";
  message?: string;
}
export async function executeArchiveHttp(
  row: BulkArchiveRow,
  request: typeof fetch = fetch,
): Promise<MutationResult> {
  if (!row.preview?.eligible || row.preview.file_id !== row.file_id)
    throw new Error("BULK_ARCHIVE_INTENT_INVALID");
  const response = await request("/api/v1/commands", {
    method: "POST",
    credentials: "same-origin",
    signal: AbortSignal.timeout(15000),
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": row.operation_id,
      "If-Match": String(row.preview.revision),
    },
    body: JSON.stringify({
      command: "file_archive",
      input: { file_id: row.file_id, explicit_user_intent: true },
    }),
  });
  const body = await response.json();
  if (!response.ok) {
    const error = new Error("FILE_ARCHIVE_REQUEST_REJECTED") as Error & {
      status: number;
      code: string;
    };
    error.status = response.status;
    error.code = body.error?.code ?? "REQUEST_FAILED";
    throw error;
  }
  return body.data as MutationResult;
}
export async function prepareBulkArchive(
  files: Pick<FileDTO, "file_id" | "title">[],
  read: (id: string) => Promise<ArchivePreview>,
  key = () => crypto.randomUUID(),
): Promise<BulkArchiveRow[]> {
  if (
    files.length < 1 ||
    files.length > 20 ||
    new Set(files.map((file) => file.file_id)).size !== files.length ||
    files.some((file) => !file.file_id || file.file_id.length > 512)
  )
    throw new Error("BULK_ARCHIVE_EXACT_IDS_REQUIRED");
  return Promise.all(
    files.map(async (file) => {
      const operation_id = key();
      try {
        const preview = await read(file.file_id);
        if (
          preview.file_id !== file.file_id ||
          !Number.isInteger(preview.revision) ||
          preview.revision < 1
        )
          throw new Error("BULK_ARCHIVE_PREVIEW_MISMATCH");
        return {
          ...file,
          operation_id,
          preview,
          state: preview.eligible ? "ready" : "blocked",
          message: preview.reason ?? undefined,
        } as BulkArchiveRow;
      } catch {
        return {
          ...file,
          operation_id,
          preview: null,
          state: "blocked",
          message: "PREVIEW_UNAVAILABLE",
        };
      }
    }),
  );
}
export async function runBulkArchive(
  rows: BulkArchiveRow[],
  confirmed: boolean,
  execute: (row: BulkArchiveRow) => Promise<MutationResult>,
  read: (id: string) => Promise<FileDTO>,
  progress?: (rows: BulkArchiveRow[]) => void,
): Promise<BulkArchiveRow[]> {
  if (
    !confirmed ||
    rows.length < 1 ||
    rows.length > 20 ||
    new Set(rows.map((row) => row.file_id)).size !== rows.length
  )
    throw new Error("BULK_ARCHIVE_CONFIRMATION_REQUIRED");
  const next = rows.map((row) => ({ ...row }));
  for (const row of next) {
    if (row.state !== "ready" && row.state !== "unconfirmed") continue;
    if (
      !row.preview?.eligible ||
      row.preview.file_id !== row.file_id ||
      !row.operation_id
    )
      throw new Error("BULK_ARCHIVE_INTENT_INVALID");
    // Preserve this exact per-file key/revision when an acknowledgement is lost.
    row.state = "unconfirmed";
    row.message = undefined;
    progress?.(next.map((value) => ({ ...value })));
    try {
      const result = await execute(row);
      if (
        result.entity_id !== row.file_id ||
        !result.operation_id ||
        !result.audit_event_id ||
        !Number.isInteger(result.version) ||
        result.version !== row.preview.revision + 1 ||
        (row.receipt_operation_id !== undefined &&
          row.receipt_operation_id !== result.operation_id) ||
        (row.receipt_audit_event_id !== undefined &&
          row.receipt_audit_event_id !== result.audit_event_id)
      )
        throw new Error("BULK_ARCHIVE_ACK_MISMATCH");
      // Client intent keys and canonical audit operation IDs are distinct.
      row.receipt_operation_id = result.operation_id;
      row.receipt_audit_event_id = result.audit_event_id;
      const metadata = await read(row.file_id);
      if (
        metadata.file_id !== row.file_id ||
        metadata.state !== "Old" ||
        typeof metadata.archived_at !== "string" ||
        !Number.isFinite(Date.parse(metadata.archived_at)) ||
        metadata.revision < result.version
      )
        throw new Error("BULK_ARCHIVE_READBACK_UNCONFIRMED");
      row.state = "succeeded";
    } catch (cause) {
      const error = cause as { status?: number; code?: string };
      row.state =
        row.receipt_operation_id === undefined &&
        error.status &&
        error.status >= 400 &&
        error.status < 500 &&
        error.status !== 408 &&
        error.code !== "IDEMPOTENCY_IN_PROGRESS"
          ? "failed"
          : "unconfirmed";
      row.message =
        row.state === "failed"
          ? (error.code ?? "ARCHIVE_REJECTED")
          : "ARCHIVE_UNCONFIRMED_RETRY_SAME_INTENT";
    }
    progress?.(next.map((value) => ({ ...value })));
  }
  return next;
}
