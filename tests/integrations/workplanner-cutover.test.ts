import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encryptBackup } from "../../server/integrations/backup";
import { workplannerCutover } from "../../scripts/migration/workplanner-cutover";
import { prepareWorkPlannerImport } from "../../scripts/migration/work-planner";
let folder: string, sourcePath: string, credentials: string, journal: string;
const key = "synthetic-backup-key-for-cutover-tests",
  origin = "http://localhost:3000";
const sourceState = {
  version: 1,
  revision: 7,
  entries: [
    {
      id: "synthetic-work",
      jobId: "jena",
      date: "2026-10-25",
      start: "01:30",
      end: "03:30",
      tasks: "Synthetic private text",
    },
    {
      id: "synthetic-draft",
      jobId: "seewiesen",
      date: "",
      start: "1:",
      end: "",
      tasks: "Synthetic unfinished",
    },
  ],
};
beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), "life-os-cutover-"));
  sourcePath = join(folder, "source.enc.json");
  credentials = join(folder, "credentials.json");
  journal = join(folder, "journal.json");
  await writeFile(
    credentials,
    JSON.stringify({
      email: "synthetic@example.invalid",
      password: "synthetic-password",
      user_id: "synthetic-actor",
      owner_id: "synthetic-owner",
      origin,
    }),
  );
  await writeFile(
    sourcePath,
    JSON.stringify(
      await encryptBackup(
        {
          format: "ramin-workplanner-source-snapshot/1",
          namespace: "synthetic-production",
          rows: [
            {
              key: "state",
              body: JSON.stringify(sourceState),
              etag: "synthetic-state-etag",
            },
            {
              key: "calendar-settings",
              body: JSON.stringify({
                feeds: [
                  {
                    name: "Synthetic feed",
                    url: "https://feeds.example.invalid/private-synthetic",
                  },
                ],
              }),
              etag: "synthetic-feed-etag",
            },
          ],
        },
        key,
      ),
    ),
  );
});
afterEach(async () => {
  await rm(folder, { recursive: true, force: true });
});
function server() {
  const commits: {
      name: string;
      input: Record<string, unknown>;
      key: string;
    }[] = [],
    accepted = new Map<string, unknown>(),
    previews = new Map<
      string,
      {
        prepared: ReturnType<typeof prepareWorkPlannerImport>;
        stateRevision: number;
      }
    >();
  const entries: unknown[] = [],
    drafts: unknown[] = [];
  let sources: Record<string, unknown>[] = [],
    loseResponse = false,
    loseImportNumber = 0,
    acceptedImportCount = 0,
    stateRevision = 0;
  const fetcher = vi.fn(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const ok = (data: unknown) => Response.json({ data });
      if (url.pathname.endsWith("/query")) {
        const posted =
          init?.method === "POST" ? JSON.parse(String(init.body)) : null;
        const operation =
            posted?.operation ?? url.searchParams.get("operation"),
          queryInput =
            posted?.input ?? JSON.parse(url.searchParams.get("input") ?? "{}");
        if (operation === "whoami")
          return ok({
            actor_id: "synthetic-actor",
            owner_id: "synthetic-owner",
          });
        if (operation === "time_entry_import_preview") {
          const id = "preview-" + previews.size;
          const prepared = prepareWorkPlannerImport(queryInput.data);
          previews.set(id, { prepared, stateRevision });
          return ok({
            preview_id: id,
            expires_at: new Date(Date.now() + 900000).toISOString(),
            input: {
              data: {
                format: "ramin-life-os-time/1",
                timezone: "Europe/Berlin",
                entries: prepared.entries,
                drafts: prepared.drafts.map((draft) => ({
                  ...draft,
                  timezone: "Europe/Berlin",
                })),
              },
              time_state_hash: String(stateRevision),
            },
          });
        }
        if (
          operation === "time_entry_export" ||
          operation === "time_draft_list"
        ) {
          const values = operation === "time_entry_export" ? entries : drafts,
            offset = Number(queryInput.cursor ?? 0),
            end = offset + 200;
          return ok({
            items: values.slice(offset, end),
            next_cursor: end < values.length ? String(end) : null,
          });
        }
        if (operation === "calendar_sync_status")
          return ok({ items: sources, next_cursor: null });
      }
      if (url.pathname.endsWith("/commands")) {
        const body = JSON.parse(String(init?.body)),
          idem = new Headers(init?.headers).get("Idempotency-Key")!;
        commits.push({ name: body.command, input: body.input, key: idem });
        if (accepted.has(idem)) return ok(accepted.get(idem));
        let result: unknown = {};
        if (body.command === "time_entry_import_commit") {
          const preview = previews.get(body.input.preview_id)!;
          if (preview.stateRevision !== stateRevision)
            return Response.json(
              { error: { code: "REVISION_CONFLICT" } },
              { status: 409 },
            );
          entries.push(...preview.prepared.entries);
          drafts.push(...preview.prepared.drafts);
          stateRevision++;
          acceptedImportCount++;
          result = { entity_id: "synthetic-import" };
        }
        if (body.command === "calendar_source_configure") {
          const external =
              "feed:" +
              createHash("sha256")
                .update(JSON.stringify(body.input.url))
                .digest("hex"),
            id =
              "CS-" +
              createHash("sha256")
                .update(JSON.stringify(["synthetic-owner", "ical", external]))
                .digest("hex")
                .slice(0, 40);
          sources = [
            {
              source_id: id,
              enabled: true,
              status: "connected",
              coverage: { complete: true },
              revision: 1,
            },
          ];
          result = { entity_id: id };
        }
        accepted.set(idem, result);
        if (
          loseResponse ||
          (body.command === "time_entry_import_commit" &&
            loseImportNumber === acceptedImportCount)
        ) {
          loseResponse = false;
          loseImportNumber = 0;
          throw new Error("Synthetic response lost after canonical commit");
        }
        return ok(result);
      }
      throw new Error("Unexpected synthetic request");
    },
  ) as unknown as typeof fetch;
  return {
    fetcher,
    commits,
    accepted,
    previews,
    counts: () => ({
      entries: entries.length,
      drafts: drafts.length,
      accepted_imports: acceptedImportCount,
    }),
    loseNextResponse: () => {
      loseResponse = true;
    },
    loseImportResponse: (number: number) => {
      loseImportNumber = number;
    },
  };
}
const signIn = async () =>
  new Response("{}", {
    headers: { "Set-Cookie": "synthetic-session=synthetic; Path=/; HttpOnly" },
  });
describe("private one-time Work Planner cutover journal", () => {
  it("requires preview then imports entries/drafts/feeds through canonical API and reconciles without source writes", async () => {
    const api = server(),
      original = await readFile(sourcePath, "utf8"),
      dependencies = { fetch: api.fetcher, signIn, key };
    await expect(
      workplannerCutover(
        ["--commit", origin, credentials, sourcePath, journal],
        dependencies,
      ),
    ).rejects.toThrow(/PREVIEW_JOURNAL_REQUIRED/);
    expect(
      await workplannerCutover(
        ["--preview", origin, credentials, sourcePath, journal],
        dependencies,
      ),
    ).toMatchObject({
      status: "previewed",
      source_entries: 2,
      completed_entries: 1,
      draft_entries: 1,
    });
    expect(api.commits).toHaveLength(0);
    expect(
      await workplannerCutover(
        ["--commit", origin, credentials, sourcePath, journal],
        dependencies,
      ),
    ).toMatchObject({
      status: "verified",
      reconciliation_verified: true,
      batches_confirmed: 1,
      feeds_confirmed: 1,
      source_written: false,
    });
    expect(api.commits.map((value) => value.name)).toEqual([
      "time_entry_import_commit",
      "calendar_source_configure",
      "calendar_sync_request",
    ]);
    expect(await readFile(sourcePath, "utf8")).toBe(original);
  });
  it("retains the original preview and idempotency key after an uncertain accepted commit", async () => {
    const api = server(),
      dependencies = { fetch: api.fetcher, signIn, key };
    await workplannerCutover(
      ["--preview", origin, credentials, sourcePath, journal],
      dependencies,
    );
    api.loseNextResponse();
    await expect(
      workplannerCutover(
        ["--commit", origin, credentials, sourcePath, journal],
        dependencies,
      ),
    ).rejects.toThrow(/response lost/);
    expect(JSON.parse(await readFile(journal, "utf8")).batches[0].status).toBe(
      "attempted",
    );
    await workplannerCutover(
      ["--commit", origin, credentials, sourcePath, journal],
      dependencies,
    );
    expect(api.commits[0]).toEqual(api.commits[1]);
    expect(api.accepted.size).toBe(3);
  });
  it("pins destination, source and authenticated actor before any business write", async () => {
    const api = server(),
      dependencies = { fetch: api.fetcher, signIn, key };
    await workplannerCutover(
      ["--preview", origin, credentials, sourcePath, journal],
      dependencies,
    );
    await writeFile(
      credentials,
      JSON.stringify({
        email: "synthetic@example.invalid",
        password: "synthetic-password",
        user_id: "other-actor",
        origin,
      }),
    );
    await expect(
      workplannerCutover(
        ["--commit", origin, credentials, sourcePath, journal],
        dependencies,
      ),
    ).rejects.toThrow(/ACTOR_MISMATCH/);
    expect(api.commits).toHaveLength(0);
    await expect(
      workplannerCutover(
        [
          "--preview",
          "https://untrusted.example.invalid",
          credentials,
          sourcePath,
          journal,
        ],
        dependencies,
      ),
    ).rejects.toThrow(/EXPLICIT_ARGUMENTS_REQUIRED/);
  });
  it("previews each batch after the previous ACK and roundtrips more than 1000 complete entries and drafts", async () => {
    const snapshot = {
      format: "ramin-workplanner-source-snapshot/1",
      namespace: "synthetic-production",
      rows: [
        {
          key: "state",
          body: JSON.stringify({
            version: 1,
            entries: [
              ...Array.from({ length: 1001 }, (_, index) => ({
                ...sourceState.entries[0],
                id: "synthetic-multibatch-" + index,
              })),
              { ...sourceState.entries[1], id: "synthetic-multibatch-draft" },
            ],
          }),
          etag: "synthetic-multibatch",
        },
      ],
    };
    await writeFile(
      sourcePath,
      JSON.stringify(await encryptBackup(snapshot, key)),
    );
    const api = server(),
      dependencies = { fetch: api.fetcher, signIn, key };
    await workplannerCutover(
      ["--preview", origin, credentials, sourcePath, journal],
      dependencies,
    );
    expect(api.previews.size).toBe(1);
    expect(
      await workplannerCutover(
        ["--commit", origin, credentials, sourcePath, journal],
        dependencies,
      ),
    ).toMatchObject({
      status: "verified",
      completed_entries: 1001,
      draft_entries: 1,
      batches_confirmed: 2,
    });
    expect(
      [...api.previews.values()].map((preview) => preview.stateRevision),
    ).toEqual([0, 1]);
    expect(api.counts()).toEqual({
      entries: 1001,
      drafts: 1,
      accepted_imports: 2,
    });
    const retained = JSON.parse(await readFile(journal, "utf8"));
    expect(
      retained.batches.every((batch: { approved_payload_hash?: string }) =>
        /^[a-f0-9]{64}$/.test(batch.approved_payload_hash ?? ""),
      ),
    ).toBe(true);
  });
  it("never refreshes the attempted second batch preview after its accepted ACK is lost", async () => {
    await writeFile(
      sourcePath,
      JSON.stringify(
        await encryptBackup(
          {
            format: "ramin-workplanner-source-snapshot/1",
            namespace: "synthetic-production",
            rows: [
              {
                key: "state",
                body: JSON.stringify({
                  version: 1,
                  entries: Array.from({ length: 1001 }, (_, index) => ({
                    ...sourceState.entries[0],
                    id: "synthetic-retry-batch-" + index,
                  })),
                }),
                etag: "synthetic-retry-batch",
              },
            ],
          },
          key,
        ),
      ),
    );
    const api = server(),
      dependencies = { fetch: api.fetcher, signIn, key };
    await workplannerCutover(
      ["--preview", origin, credentials, sourcePath, journal],
      dependencies,
    );
    api.loseImportResponse(2);
    await expect(
      workplannerCutover(
        ["--commit", origin, credentials, sourcePath, journal],
        dependencies,
      ),
    ).rejects.toThrow(/response lost/);
    const uncertain = JSON.parse(await readFile(journal, "utf8"));
    expect(
      uncertain.batches.map((batch: { status: string }) => batch.status),
    ).toEqual(["confirmed", "attempted"]);
    expect(api.previews.size).toBe(2);
    expect(
      await workplannerCutover(
        ["--commit", origin, credentials, sourcePath, journal],
        dependencies,
      ),
    ).toMatchObject({ status: "verified", batches_confirmed: 2 });
    expect(api.previews.size).toBe(2);
    expect(api.commits[1]).toEqual(api.commits[2]);
    expect(api.counts()).toEqual({
      entries: 1001,
      drafts: 0,
      accepted_imports: 2,
    });
  });
  it("rejects a preview whose normalized business payload differs from the pinned source batch", async () => {
    const api = server();
    const tamperedFetch: typeof fetch = async (input, init) => {
      const response = await api.fetcher(input, init);
      if (
        String(input).endsWith("/query") &&
        String(init?.body).includes("time_entry_import_preview")
      ) {
        const payload = await response.json();
        payload.data.input.data.entries[0].description =
          "Synthetic unauthorized replacement";
        return Response.json(payload);
      }
      return response;
    };
    await expect(
      workplannerCutover(
        ["--preview", origin, credentials, sourcePath, journal],
        { fetch: tamperedFetch, signIn, key },
      ),
    ).rejects.toThrow(/PREVIEW_SEMANTIC_MISMATCH/);
    expect(api.commits).toHaveLength(0);
    expect(JSON.parse(await readFile(journal, "utf8")).status).toBe(
      "preparing",
    );
  });
});
