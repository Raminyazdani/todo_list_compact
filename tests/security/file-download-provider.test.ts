import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { FileProvider, Principal } from "@/shared/contracts";

const mocks = vi.hoisted(() => ({
  principal: vi.fn(),
  metadata: vi.fn(),
  query: vi.fn(),
  send: vi.fn(),
  blobGet: vi.fn(),
}));
vi.mock("@/server/auth/principal", () => ({
  requirePrincipal: mocks.principal,
}));
vi.mock("@/server/domain/service", () => ({
  getDomainService: () => ({ query: mocks.metadata }),
}));
vi.mock("@/server/db/database", () => ({
  getDatabase: () => ({ query: mocks.query }),
}));
vi.mock("@/server/http", async (original) => ({
  ...(await original<typeof import("@/server/http")>()),
  rateLimit: vi.fn(),
}));
vi.mock("@aws-sdk/client-s3", async (original) => ({
  ...(await original<typeof import("@aws-sdk/client-s3")>()),
  S3Client: class {
    send = mocks.send;
    destroy() {}
  },
}));
vi.mock("@vercel/blob", () => ({ get: mocks.blobGet }));
import { GET } from "@/app/api/v1/files/[fileId]/download/route";
import { ownerStoragePrefix } from "@/server/integrations/storage";
import { DomainError } from "@/shared/contracts";

const principal: Principal = {
  ownerId: "synthetic-download-owner",
  actorId: "synthetic-download-owner",
  scopes: ["files:read"],
  channel: "UI",
};
const storageKey =
  ownerStoragePrefix(principal.ownerId) + "a".repeat(64) + "/original";
const context = { params: Promise.resolve({ fileId: "synthetic-file" }) };
function record(provider: FileProvider) {
  mocks.query.mockResolvedValue({
    rows: [
      {
        provider,
        storage_key: storageKey,
        original_filename: "synthetic.txt",
        mime_type: "text/plain",
        external_url: "https://drive.google.com/file/d/synthetic/view",
      },
    ],
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.principal.mockResolvedValue(principal);
  mocks.metadata.mockResolvedValue({ file_id: "synthetic-file" });
  vi.stubEnv("PRIVATE_STORAGE_PROVIDER", "neon_object_storage");
  vi.stubEnv(
    "NEON_STORAGE_ENDPOINT_URL_S3",
    "https://synthetic.storage.neon.tech",
  );
  vi.stubEnv("NEON_STORAGE_REGION", "eu-central-1");
  vi.stubEnv("NEON_STORAGE_BUCKET", "synthetic-private-bucket");
  vi.stubEnv("NEON_STORAGE_ACCESS_KEY_ID", "synthetic-access-key");
  vi.stubEnv("NEON_STORAGE_SECRET_ACCESS_KEY", "synthetic-secret-key");
  vi.stubEnv("BLOB_READ_WRITE_TOKEN", "synthetic-legacy-token");
  mocks.send.mockImplementation(async () => ({
    Body: new Response("synthetic-neon-bytes").body!,
    ContentLength: 20,
  }));
  mocks.blobGet.mockImplementation(async () => ({
    statusCode: 200,
    stream: new Response("synthetic-blob-bytes").body!,
  }));
});
afterEach(() => vi.unstubAllEnvs());

test.each(["private_blob", "neon_object_storage"] as const)(
  "download selects the stored %s provider despite the selected new-file backend or injected query",
  async (provider) => {
    record(provider);
    const response = await GET(
      new Request(
        "https://example.test/api/v1/files/synthetic-file/download?provider=google_drive",
      ),
      context,
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(
      provider === "private_blob"
        ? "synthetic-blob-bytes"
        : "synthetic-neon-bytes",
    );
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(mocks.send).toHaveBeenCalledTimes(
      provider === "neon_object_storage" ? 1 : 0,
    );
    expect(mocks.blobGet).toHaveBeenCalledTimes(
      provider === "private_blob" ? 1 : 0,
    );
  },
);

test("an existing Drive reference keeps its authenticated redirect and reads neither private backend", async () => {
  record("google_drive");
  const response = await GET(
    new Request("https://example.test/download"),
    context,
  );
  expect(response.status).toBe(302);
  expect(response.headers.get("Location")).toBe(
    "https://drive.google.com/file/d/synthetic/view",
  );
  expect(mocks.send).not.toHaveBeenCalled();
  expect(mocks.blobGet).not.toHaveBeenCalled();
});

test("canonical owner denial prevents metadata SQL and all provider reads", async () => {
  mocks.metadata.mockRejectedValue(
    new DomainError("ENTITY_NOT_FOUND", "File not found", {}, 404),
  );
  const response = await GET(
    new Request("https://example.test/download"),
    context,
  );
  expect(response.status).toBe(404);
  expect(mocks.query).not.toHaveBeenCalled();
  expect(mocks.send).not.toHaveBeenCalled();
  expect(mocks.blobGet).not.toHaveBeenCalled();
});
