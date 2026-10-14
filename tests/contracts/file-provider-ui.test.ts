import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { FileDTO } from "../../shared/contracts";
import { FileWorkspace } from "../../features/files";

const fixture = vi.hoisted(() => ({
  file: null as FileDTO | null,
  versions: [] as FileDTO[],
  storageConfigured: true,
}));
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams({ file: "F-synthetic-ui" }),
}));
vi.mock("../../features/api", () => ({
  clearQueryCache: vi.fn(),
  query: vi.fn(),
  useQuery: (operation: string) => ({
    loading: false,
    error: null,
    refresh: vi.fn(),
    data:
      operation === "file_get_metadata"
        ? fixture.file
        : operation === "system_capabilities"
          ? { storage_configured: fixture.storageConfigured }
          : operation === "file_list_versions"
            ? { items: fixture.versions, total: fixture.versions.length }
            : { items: [], total: 0 },
  }),
}));
// Expose the real modal children to server rendering; no dialog/browser behavior
// or live storage is claimed by these focused consumer tests.
vi.mock("../../components/ui", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../components/ui")>()),
  Modal: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open
      ? createElement("section", { "data-synthetic-modal": true }, children)
      : null,
}));
const syntheticFile = (provider: FileDTO["provider"]): FileDTO => ({
  file_id: "F-synthetic-ui",
  title: "Synthetic private file",
  original_filename: "synthetic.txt",
  provider,
  external_id: provider === "google_drive" ? "synthetic-drive" : null,
  external_url:
    provider === "google_drive"
      ? "https://drive.google.com/file/d/synthetic-drive/view"
      : null,
  state: provider === "google_drive" ? "External" : "Inbox",
  mime_type: "text/plain",
  size_bytes: 9,
  sha256: "a".repeat(64),
  version_group_id: "V-synthetic-ui",
  revision: 1,
  archived_at: null,
  legacy_metadata: {},
});
function renderWorkspace() {
  return renderToStaticMarkup(
    createElement(FileWorkspace, { action: async () => null, onOpen: vi.fn() }),
  );
}
function uploadInputs(html: string) {
  return [...html.matchAll(/<input\b[^>]*type="file"[^>]*>/g)].map(
    (match) => match[0],
  );
}
beforeEach(() => {
  fixture.storageConfigured = true;
  fixture.file = syntheticFile("neon_object_storage");
  fixture.versions = [];
});
describe("Private file UI consumers with synthetic query fixtures", () => {
  it.each(["private_blob", "neon_object_storage"] as const)(
    "%s allows a version upload and gives exact authenticated links for both private version providers",
    (provider) => {
      fixture.file = syntheticFile(provider);
      fixture.versions = [
        { ...syntheticFile("private_blob"), file_id: "F-blob-version" },
        { ...syntheticFile("neon_object_storage"), file_id: "F-neon-version" },
      ];
      const html = renderWorkspace();
      const inputs = uploadInputs(html);
      expect(inputs).toHaveLength(2);
      expect(inputs.every((input) => !input.includes("disabled"))).toBe(true);
      expect(html).toContain('href="/api/v1/files/F-blob-version/download"');
      expect(html).toContain('href="/api/v1/files/F-neon-version/download"');
      expect(html).not.toContain("storage_key");
    },
  );
  it("an unconfigured provider disables both uploads even for an existing Neon file", () => {
    fixture.storageConfigured = false;
    const inputs = uploadInputs(renderWorkspace());
    expect(inputs).toHaveLength(2);
    expect(inputs.every((input) => input.includes('disabled=""'))).toBe(true);
  });
  it("a Google original remains a reference with version uploads disabled and no private download link", () => {
    fixture.file = syntheticFile("google_drive");
    fixture.versions = [fixture.file];
    const html = renderWorkspace();
    const inputs = uploadInputs(html);
    expect(inputs).toHaveLength(2);
    expect(inputs[0]).not.toContain("disabled");
    expect(inputs[1]).toContain('disabled=""');
    expect(html).toContain(
      'href="https://drive.google.com/file/d/synthetic-drive/view"',
    );
    expect(html).not.toContain('href="/api/v1/files/F-synthetic-ui/download"');
  });
});
