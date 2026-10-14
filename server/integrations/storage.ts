import { createHash } from "node:crypto";
import { get, put } from "@vercel/blob";
import { DomainError, type Principal } from "../../shared/contracts";
import {
  neonStorageCapabilities,
  putNeonObject,
  readNeonObject,
} from "./neon-storage";

export type PrivateStorageProvider = "private_blob" | "neon_object_storage";

export const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;
const allowedMime = new Set([
  "application/pdf",
  "application/zip",
  "application/octet-stream",
  "text/plain",
  "image/png",
  "image/jpeg",
  "image/webp",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
]);
const digest = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
export function ownerStoragePrefix(ownerId: string): string {
  return `owners/${digest(ownerId)}/files/`;
}
export function isOwnerStorageKey(
  storageKey: string,
  ownerId: string,
): boolean {
  return (
    storageKey.startsWith(ownerStoragePrefix(ownerId)) &&
    /^owners\/[a-f0-9]{64}\/files\/[a-f0-9]{64}\/original$/.test(storageKey)
  );
}
function requireScope(principal: Principal, write: boolean) {
  if (
    !principal.ownerId ||
    !principal.actorId ||
    !(
      principal.scopes.includes("admin:manage") ||
      principal.scopes.includes(write ? "files:write" : "files:read")
    )
  )
    throw new DomainError(
      "INSUFFICIENT_PERMISSIONS",
      "File scope is required.",
      {},
      403,
    );
}
function storageToken() {
  if (!process.env.BLOB_READ_WRITE_TOKEN)
    throw new DomainError(
      "UNSUPPORTED_OPERATION",
      "Private file storage is disconnected. Attach an approved private Blob store.",
      {},
      503,
    );
  return process.env.BLOB_READ_WRITE_TOKEN;
}
export function selectedPrivateStorageProvider(): PrivateStorageProvider {
  const provider = process.env.PRIVATE_STORAGE_PROVIDER || "private_blob";
  if (provider !== "private_blob" && provider !== "neon_object_storage")
    throw new DomainError(
      "UNSUPPORTED_OPERATION",
      "The selected private storage provider is unsupported.",
      {},
      503,
    );
  return provider;
}
function requireProvider(provider: PrivateStorageProvider) {
  if (provider !== "private_blob" && provider !== "neon_object_storage")
    throw new DomainError(
      "UNSUPPORTED_OPERATION",
      "Unsupported private storage provider.",
      {},
      503,
    );
}
export function storageCapabilities() {
  const provider = process.env.PRIVATE_STORAGE_PROVIDER || "private_blob";
  const readiness =
    provider === "neon_object_storage"
      ? neonStorageCapabilities()
      : {
          configured:
            provider === "private_blob" && !!process.env.BLOB_READ_WRITE_TOKEN,
          immutable_put_verified: provider === "private_blob",
          connected:
            provider === "private_blob" && !!process.env.BLOB_READ_WRITE_TOKEN,
        };
  return {
    provider,
    ...readiness,
    max_upload_bytes: MAX_UPLOAD_BYTES,
    scanning:
      "Signature validation and attachment-only delivery; antivirus scanning is not configured.",
    public_listing: false,
  };
}
/** Backup readiness additionally requires authenticated encryption, independently of file health. */
export function backupStorageCapabilities() {
  const storage = storageCapabilities();
  const encryption_configured = !!process.env.BACKUP_ENCRYPTION_KEY;
  return {
    provider: storage.provider,
    configured: storage.configured,
    immutable_put_verified: storage.immutable_put_verified,
    encryption_configured,
    connected: storage.connected && encryption_configured,
    public_listing: false,
  };
}

async function boundedFileBytes(stream: ReadableStream<Uint8Array>) {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_UPLOAD_BYTES) {
        await reader.cancel();
        throw new DomainError(
          "INVALID_INPUT",
          "Private upload exceeds size policy.",
        );
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size);
}
export function validateUpload(
  bytes: Uint8Array,
  filename: string,
  mimeType: string,
) {
  if (
    !filename ||
    filename.length > 240 ||
    /[\\/\u0000-\u001f]/.test(filename) ||
    filename === "." ||
    filename === ".."
  )
    throw new DomainError("INVALID_INPUT", "Invalid original filename.");
  if (
    bytes.length < 1 ||
    bytes.length > MAX_UPLOAD_BYTES ||
    !allowedMime.has(mimeType)
  )
    throw new DomainError(
      "INVALID_INPUT",
      "File size or type is not supported.",
    );
  const prefix = Buffer.from(bytes.subarray(0, 16));
  if (
    mimeType === "application/pdf" &&
    !prefix.subarray(0, 5).equals(Buffer.from("%PDF-"))
  )
    throw new DomainError("INVALID_INPUT", "PDF signature does not match.");
  if (
    mimeType === "image/png" &&
    !prefix
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    throw new DomainError("INVALID_INPUT", "PNG signature does not match.");
  if (
    mimeType === "image/jpeg" &&
    !(prefix[0] === 255 && prefix[1] === 216 && prefix[2] === 255)
  )
    throw new DomainError("INVALID_INPUT", "JPEG signature does not match.");
  if (
    (mimeType === "application/zip" || mimeType.includes("openxmlformats")) &&
    !(prefix[0] === 80 && prefix[1] === 75 && [3, 5, 7].includes(prefix[2]))
  )
    throw new DomainError(
      "INVALID_INPUT",
      "ZIP container signature does not match.",
    );
  if (
    mimeType === "image/webp" &&
    !(
      prefix.subarray(0, 4).toString() === "RIFF" &&
      prefix.subarray(8, 12).toString() === "WEBP"
    )
  )
    throw new DomainError("INVALID_INPUT", "WebP signature does not match.");
  return {
    original_filename: filename,
    mime_type: mimeType,
    size_bytes: bytes.length,
    sha256: digest(bytes),
  };
}
export interface UploadedPrivateFile {
  original_filename: string;
  mime_type: string;
  size_bytes: number;
  sha256: string;
  storage_key: string;
  provider: PrivateStorageProvider;
}
/** Distinct operation/version keys preserve originals. Blob and SQL are separate steps. */
export async function uploadPrivateFile(
  bytes: Uint8Array,
  filename: string,
  mimeType: string,
  principal: Principal,
  idempotencyKey: string,
): Promise<UploadedPrivateFile> {
  requireScope(principal, true);
  if (!idempotencyKey || idempotencyKey.length > 200)
    throw new DomainError(
      "INVALID_INPUT",
      "A stable upload idempotency key is required.",
    );
  const metadata = validateUpload(bytes, filename, mimeType);
  const storage_key = `${ownerStoragePrefix(principal.ownerId)}${digest(idempotencyKey)}/original`;
  const provider = selectedPrivateStorageProvider();
  if (provider === "neon_object_storage") {
    if (!neonStorageCapabilities().connected)
      throw new DomainError(
        "UNSUPPORTED_OPERATION",
        "Private Neon storage writes are disconnected or unverified.",
        {},
        503,
      );
    const existing = await readNeonObject(
      storage_key,
      principal.ownerId,
      "files",
      MAX_UPLOAD_BYTES,
    );
    if (existing) {
      if (
        digest(existing) !== metadata.sha256 ||
        existing.length !== metadata.size_bytes
      )
        throw new DomainError(
          "IDEMPOTENCY_CONFLICT",
          "Stored upload bytes conflict with this operation.",
        );
      return { ...metadata, storage_key, provider };
    }
    await putNeonObject(
      storage_key,
      principal.ownerId,
      "files",
      bytes,
      mimeType,
      MAX_UPLOAD_BYTES,
    );
    const readback = await readNeonObject(
      storage_key,
      principal.ownerId,
      "files",
      MAX_UPLOAD_BYTES,
    );
    if (
      !readback ||
      readback.length !== metadata.size_bytes ||
      digest(readback) !== metadata.sha256
    )
      throw new DomainError(
        "UNSUPPORTED_OPERATION",
        "Upload read-back checksum verification failed.",
        {},
        503,
      );
    return { ...metadata, storage_key, provider };
  }
  const token = storageToken();
  const existing = await get(storage_key, { access: "private", token });
  if (existing?.statusCode === 200 && existing.stream) {
    const restored = await boundedFileBytes(existing.stream);
    if (
      digest(restored) !== metadata.sha256 ||
      restored.length !== metadata.size_bytes
    )
      throw new DomainError(
        "IDEMPOTENCY_CONFLICT",
        "Stored upload bytes conflict with this operation.",
      );
    return { ...metadata, storage_key, provider: "private_blob" };
  }
  if (existing)
    throw new DomainError(
      "UNSUPPORTED_OPERATION",
      "Private upload lookup failed.",
      {},
      503,
    );
  await put(storage_key, Buffer.from(bytes), {
    access: "private",
    token,
    addRandomSuffix: false,
    allowOverwrite: false,
    contentType: mimeType,
  });
  const verified = await get(storage_key, { access: "private", token });
  if (!verified?.stream || verified.statusCode !== 200)
    throw new DomainError(
      "UNSUPPORTED_OPERATION",
      "Upload outcome is uncertain; reconcile the same storage key before retrying.",
      {},
      503,
    );
  const readback = await boundedFileBytes(verified.stream);
  if (
    readback.length !== metadata.size_bytes ||
    digest(readback) !== metadata.sha256
  )
    throw new DomainError(
      "UNSUPPORTED_OPERATION",
      "Upload read-back checksum verification failed.",
      {},
      503,
    );
  return { ...metadata, storage_key, provider: "private_blob" };
}
export async function readPrivateFile(
  storageKey: string,
  principal: Principal,
  provider: PrivateStorageProvider = "private_blob",
) {
  requireScope(principal, false);
  if (!isOwnerStorageKey(storageKey, principal.ownerId))
    throw new DomainError(
      "INSUFFICIENT_PERMISSIONS",
      "File key is outside the authenticated owner namespace.",
      {},
      403,
    );
  requireProvider(provider);
  if (provider === "neon_object_storage") {
    const bytes = await readNeonObject(
      storageKey,
      principal.ownerId,
      "files",
      MAX_UPLOAD_BYTES,
    );
    if (!bytes)
      throw new DomainError(
        "ENTITY_NOT_FOUND",
        "Private file bytes were not found.",
        {},
        404,
      );
    return new Response(new Uint8Array(bytes)).body!;
  }
  const result = await get(storageKey, {
    access: "private",
    token: storageToken(),
  });
  if (!result?.stream || result.statusCode !== 200)
    throw new DomainError(
      "ENTITY_NOT_FOUND",
      "Private file bytes were not found.",
      {},
      404,
    );
  return result.stream;
}
/** Canonical registration verifies provider bytes even when called directly over MCP. */
export async function verifyPrivateFileMetadata(
  storageKey: string,
  principal: Principal,
  provider: PrivateStorageProvider = "private_blob",
): Promise<{ sha256: string; size_bytes: number }> {
  requireScope(principal, true);
  if (!isOwnerStorageKey(storageKey, principal.ownerId))
    throw new DomainError(
      "INSUFFICIENT_PERMISSIONS",
      "Upload storage key is outside the owner namespace.",
      {},
      403,
    );
  requireProvider(provider);
  if (provider === "neon_object_storage") {
    const bytes = await readNeonObject(
      storageKey,
      principal.ownerId,
      "files",
      MAX_UPLOAD_BYTES,
    );
    if (!bytes)
      throw new DomainError(
        "ENTITY_NOT_FOUND",
        "Verified private upload bytes were not found.",
        {},
        404,
      );
    if (!bytes.length)
      throw new DomainError("INVALID_INPUT", "Private upload is empty.");
    return { sha256: digest(bytes), size_bytes: bytes.length };
  }
  const result = await get(storageKey, {
    access: "private",
    token: storageToken(),
  });
  if (!result?.stream || result.statusCode !== 200)
    throw new DomainError(
      "ENTITY_NOT_FOUND",
      "Verified private upload bytes were not found.",
      {},
      404,
    );
  const reader = result.stream.getReader(),
    hash = createHash("sha256");
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_UPLOAD_BYTES) {
        await reader.cancel();
        throw new DomainError(
          "INVALID_INPUT",
          "Private upload exceeds size policy.",
        );
      }
      hash.update(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  if (!size) throw new DomainError("INVALID_INPUT", "Private upload is empty.");
  return { sha256: hash.digest("hex"), size_bytes: size };
}
export function attachmentHeaders(filename: string, mimeType: string) {
  const name = filename.replace(/["\\\r\n]/g, "_");
  return {
    "Content-Type": allowedMime.has(mimeType)
      ? mimeType
      : "application/octet-stream",
    "Content-Disposition": `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(name)}`,
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "private, no-store",
    "Content-Security-Policy": "default-src 'none'; sandbox",
  };
}
export interface ArchiveFile {
  state: string;
  protected?: boolean;
  provider: string;
}
export function archiveEligibility(
  file: ArchiveFile,
  links: Array<{ active: boolean; task_id: string }>,
  tasks: Array<{ task_id: string; status: string }>,
) {
  if (file.protected || file.state === "External")
    return { eligible: false, reason: "protected_or_external_source" };
  const active = links.filter((link) => link.active);
  if (!active.length)
    return {
      eligible: false,
      reason: "no_active_links_requires_explicit_intent",
    };
  const states = new Map(tasks.map((task) => [task.task_id, task.status]));
  if (active.some((link) => !states.has(link.task_id)))
    return { eligible: false, reason: "missing_linked_task" };
  if (
    active.some(
      (link) => !["Done", "Cancelled"].includes(states.get(link.task_id)!),
    )
  )
    return { eligible: false, reason: "linked_task_open" };
  return { eligible: true, reason: "all_active_linked_tasks_closed" };
}
