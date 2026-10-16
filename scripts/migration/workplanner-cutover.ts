import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { decryptBackup } from "../../server/integrations/backup";
import { prepareWorkPlannerImport } from "./work-planner";
import { hash as canonicalHash } from "../../server/domain/core";
import { boundedSignIn } from "../ops/bounded-signin.mjs";
import {
  admitPrivatePath,
  replacePinnedContents,
  withPrivateFile,
  writeExclusivePrivateJson,
} from "../ops/private-paths.mjs";

type ObjectValue = Record<string, unknown>;
type Operation = {
  key: string;
  status: "prepared" | "attempted" | "confirmed";
  preview_id?: string;
  expires_at?: string;
  result?: ObjectValue;
  command?: string;
  input?: ObjectValue;
  expected_revision?: number;
  approved_payload_hash?: string;
};
type Journal = {
  format: "ramin-workplanner-cutover/1";
  origin: string;
  owner_id: string;
  actor_id: string;
  source_hash: string;
  intent_hash: string;
  status: "preparing" | "previewed" | "committing" | "verified";
  batches: Operation[];
  feeds: Operation[];
  sync: Operation;
  reconciliation?: ObjectValue;
};
type Credentials = {
  email: string;
  password: string;
  user_id: string;
  owner_id?: string;
  origin?: string;
};
export interface CutoverDependencies {
  fetch?: typeof fetch;
  signIn?: typeof boundedSignIn;
  key?: string;
  repositoryRoot?: string;
}
function object(value: unknown): ObjectValue {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("CUTOVER_INVALID_RESPONSE");
  return value as ObjectValue;
}
function digest(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function importIdentity(entries: ObjectValue[], drafts: ObjectValue[]) {
  const select = (row: ObjectValue, fields: string[]) =>
    Object.fromEntries(fields.map((field) => [field, row[field]]));
  return {
    entries: entries
      .map((entry) =>
        select(entry, [
          "entry_id",
          "employer",
          "starts_at",
          "ends_at",
          "description",
          "task_id",
          "reporting_policy",
          "reported_minutes",
          "legacy_metadata",
        ]),
      )
      .sort((a, b) => String(a.entry_id).localeCompare(String(b.entry_id))),
    drafts: drafts
      .map((draft) =>
        select({ ...draft, timezone: draft.timezone ?? "Europe/Berlin" }, [
          "draft_id",
          "employer",
          "date",
          "start",
          "end",
          "end_next_day",
          "description",
          "timezone",
          "legacy_metadata",
        ]),
      )
      .sort((a, b) => String(a.draft_id).localeCompare(String(b.draft_id))),
  };
}
async function privateJson(path: string, repositoryRoot?: string) {
  return withPrivateFile(
    path,
    async (file) => JSON.parse(await file.readFile("utf8")),
    { repositoryRoot },
  );
}
function chunks(entries: unknown[]) {
  const result: unknown[][] = [];
  let chunk: unknown[] = [];
  for (const entry of entries) {
    if (
      chunk.length >= 1000 ||
      Buffer.byteLength(JSON.stringify([...chunk, entry])) > 1900000
    ) {
      result.push(chunk);
      chunk = [];
    }
    if (Buffer.byteLength(JSON.stringify(entry)) > 1800000)
      throw new Error("CUTOVER_RECORD_TOO_LARGE");
    chunk.push(entry);
  }
  if (chunk.length) result.push(chunk);
  return result;
}
function publicReceipt(
  journal: Journal,
  entryCount: number,
  completeCount: number,
  draftCount: number,
) {
  return {
    status: journal.status,
    source_written: false,
    source_entries: entryCount,
    completed_entries: completeCount,
    draft_entries: draftCount,
    batches: journal.batches.length,
    batches_confirmed: journal.batches.filter(
      (value) => value.status === "confirmed",
    ).length,
    feeds: journal.feeds.length,
    feeds_confirmed: journal.feeds.filter(
      (value) => value.status === "confirmed",
    ).length,
    reconciliation_verified: journal.reconciliation?.verified === true,
  };
}
/** Explicit coordinator CLI. Source files are only read; all destination writes use owner API. */
export async function workplannerCutover(
  args: string[],
  dependencies: CutoverDependencies = {},
) {
  const [
    mode,
    origin,
    credentialsPath,
    encryptedSourcePath,
    journalPath,
    ...extra
  ] = args;
  if (
    !["--preview", "--commit"].includes(mode) ||
    !["http://localhost:3000", "https://ramin-life-os.vercel.app"].includes(
      origin,
    ) ||
    !journalPath ||
    extra.length
  )
    throw new Error("CUTOVER_EXPLICIT_ARGUMENTS_REQUIRED");
  const admission = { repositoryRoot: dependencies.repositoryRoot };
  await admitPrivatePath(journalPath, admission);
  const credentials = object(
    await privateJson(credentialsPath, dependencies.repositoryRoot),
  ) as unknown as Credentials;
  if (
    !credentials.user_id ||
    !credentials.email ||
    !credentials.password ||
    (credentials.origin && credentials.origin !== origin)
  )
    throw new Error("CUTOVER_OWNER_CREDENTIALS_MISMATCH");
  const encrypted = (await privateJson(
    encryptedSourcePath,
    dependencies.repositoryRoot,
  )) as Parameters<typeof decryptBackup>[0];
  const key = dependencies.key ?? process.env.BACKUP_ENCRYPTION_KEY;
  if (!key) throw new Error("CUTOVER_SOURCE_ENCRYPTION_KEY_REQUIRED");
  const snapshot = object(await decryptBackup(encrypted, key));
  if (
    snapshot.format !== "ramin-workplanner-source-snapshot/1" ||
    !Array.isArray(snapshot.rows)
  )
    throw new Error("CUTOVER_SOURCE_FORMAT_INVALID");
  const rows = snapshot.rows.map(object),
    stateBody = rows.find((row) => row.key === "state")?.body;
  if (typeof stateBody !== "string")
    throw new Error("CUTOVER_SOURCE_STATE_REQUIRED");
  const state = object(JSON.parse(stateBody)),
    prepared = prepareWorkPlannerImport(state);
  if (!prepared.ready)
    throw new Error("CUTOVER_RESOLVE_SOURCE_INTERVALS_FIRST");
  const legacyEntries = state.entries as unknown[],
    batches = chunks(legacyEntries);
  const settingsBody = rows.find(
    (row) => row.key === "calendar-settings",
  )?.body;
  const settings =
    typeof settingsBody === "string"
      ? object(JSON.parse(settingsBody))
      : { feeds: [] };
  if (!Array.isArray(settings.feeds) || settings.feeds.length > 100)
    throw new Error("CUTOVER_SOURCE_FEEDS_INVALID");
  const urls = new Set<string>(),
    feeds = settings.feeds.map(object).filter((feed) => {
      if (typeof feed.url !== "string")
        throw new Error("CUTOVER_SOURCE_FEED_URL_REQUIRED");
      const url = new URL(feed.url);
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        url.hash ||
        (url.port && url.port !== "443")
      )
        throw new Error("CUTOVER_SOURCE_FEED_URL_INVALID");
      if (urls.has(url.toString())) return false;
      urls.add(url.toString());
      return true;
    });
  const sourceHash = digest([
    snapshot.namespace,
    rows.map((row) => [row.key, row.body, row.etag]),
  ]);
  const fetcher = dependencies.fetch ?? fetch,
    signedIn = await (dependencies.signIn ?? boundedSignIn)(
      origin,
      credentials,
      { fetch: fetcher },
    );
  if (!signedIn.ok) throw new Error("CUTOVER_SIGNIN_FAILED");
  const cookie = signedIn.headers
    .getSetCookie()
    .map((line) => line.split(";")[0])
    .join("; ");
  if (!cookie) throw new Error("CUTOVER_SESSION_REQUIRED");
  const query = async (operation: string, input: ObjectValue = {}) => {
    const post =
      operation.endsWith("_preview") || JSON.stringify(input).length > 4000;
    const response = await fetcher(
      origin +
        "/api/v1/query" +
        (post
          ? ""
          : "?" +
            new URLSearchParams({ operation, input: JSON.stringify(input) })),
      {
        ...(post
          ? { method: "POST", body: JSON.stringify({ operation, input }) }
          : {}),
        headers: {
          Cookie: cookie,
          ...(post
            ? { Origin: origin, "Content-Type": "application/json" }
            : {}),
        },
        redirect: "error",
        signal: AbortSignal.timeout(60000),
      },
    );
    const body = object(await response.json());
    if (!response.ok)
      throw new Error("CUTOVER_QUERY_FAILED_" + response.status);
    return object(body.data);
  };
  const identity = await query("whoami");
  if (
    identity.actor_id !== credentials.user_id &&
    identity.actorId !== credentials.user_id
  )
    throw new Error("CUTOVER_ACTOR_MISMATCH");
  const ownerId = String(identity.owner_id ?? identity.ownerId ?? "");
  if (!ownerId || (credentials.owner_id && credentials.owner_id !== ownerId))
    throw new Error("CUTOVER_OWNER_MISMATCH");
  const intentHash = digest([origin, ownerId, credentials.user_id, sourceHash]);
  let journal: Journal;
  try {
    journal = (await privateJson(
      journalPath,
      dependencies.repositoryRoot,
    )) as Journal;
  } catch (error) {
    if (
      !error ||
      typeof error !== "object" ||
      !("code" in error) ||
      error.code !== "ENOENT" ||
      mode !== "--preview"
    )
      throw new Error("CUTOVER_PREVIEW_JOURNAL_REQUIRED");
    journal = {
      format: "ramin-workplanner-cutover/1",
      origin,
      owner_id: ownerId,
      actor_id: credentials.user_id,
      source_hash: sourceHash,
      intent_hash: intentHash,
      status: "preparing",
      batches: batches.map((_, index) => ({
        key: "wp-" + intentHash + "-batch-" + index,
        status: "prepared",
      })),
      feeds: feeds.map((_, index) => ({
        key: "wp-" + intentHash + "-feed-" + index,
        status: "prepared",
      })),
      sync: { key: "wp-" + intentHash + "-sync", status: "prepared" },
    };
    await writeExclusivePrivateJson(journalPath, journal, admission);
  }
  if (
    journal.format !== "ramin-workplanner-cutover/1" ||
    journal.origin !== origin ||
    journal.owner_id !== ownerId ||
    journal.actor_id !== credentials.user_id ||
    journal.source_hash !== sourceHash ||
    journal.intent_hash !== intentHash ||
    journal.batches.length !== batches.length ||
    journal.feeds.length !== feeds.length
  )
    throw new Error("CUTOVER_JOURNAL_INTENT_MISMATCH");
  const save = () =>
    withPrivateFile(
      journalPath,
      (file) =>
        replacePinnedContents(file, JSON.stringify(journal, null, 2) + "\n"),
      admission,
    );
  const previewBatch = async (index: number, refresh = false) => {
    const operation = journal.batches[index];
    // A possibly accepted commit must ALWAYS replay the original preview ID and key.
    if (operation.status !== "prepared") return;
    const expected = prepareWorkPlannerImport({
      version: 1,
      entries: batches[index],
    });
    const approvedHash = canonicalHash(
      importIdentity(expected.entries, expected.drafts),
    );
    if (
      operation.approved_payload_hash &&
      operation.approved_payload_hash !== approvedHash
    )
      throw new Error("CUTOVER_APPROVED_BATCH_CHANGED");
    if (
      !refresh &&
      operation.approved_payload_hash === approvedHash &&
      operation.preview_id &&
      operation.expires_at &&
      Date.parse(operation.expires_at) > Date.now() + 30000
    )
      return;
    const preview = await query("time_entry_import_preview", {
      data: { version: 1, entries: batches[index] },
      timezone: "Europe/Berlin",
    });
    if (
      typeof preview.preview_id !== "string" ||
      typeof preview.expires_at !== "string"
    )
      throw new Error("CUTOVER_IMPORT_PREVIEW_INVALID");
    const previewData = object(object(preview.input).data);
    if (
      previewData.format !== "ramin-life-os-time/1" ||
      previewData.timezone !== "Europe/Berlin" ||
      !Array.isArray(previewData.entries) ||
      !Array.isArray(previewData.drafts) ||
      canonicalHash(
        importIdentity(
          previewData.entries.map(object),
          previewData.drafts.map(object),
        ),
      ) !== approvedHash
    )
      throw new Error("CUTOVER_IMPORT_PREVIEW_SEMANTIC_MISMATCH");
    operation.preview_id = preview.preview_id;
    operation.expires_at = preview.expires_at;
    operation.approved_payload_hash = approvedHash;
    await save();
  };
  if (mode === "--preview") {
    const first = journal.batches.findIndex(
      (operation) => operation.status !== "confirmed",
    );
    if (first >= 0) await previewBatch(first);
    if (journal.status === "preparing") {
      journal.status = "previewed";
      await save();
    }
    return publicReceipt(
      journal,
      legacyEntries.length,
      prepared.entries.length,
      prepared.drafts.length,
    );
  }
  if (journal.status === "preparing")
    throw new Error("CUTOVER_SUCCESSFUL_PREVIEW_REQUIRED");
  journal.status = "committing";
  await save();
  const command = async (
    name: string,
    input: ObjectValue,
    operation: Operation,
    expectedRevision?: number,
  ) => {
    if (operation.status === "confirmed") return operation.result ?? {};
    if (operation.command && operation.command !== name)
      throw new Error("CUTOVER_RETAINED_COMMAND_MISMATCH");
    if (!operation.command) {
      operation.command = name;
      operation.input = input;
      operation.expected_revision = expectedRevision;
    }
    operation.status = "attempted";
    await save();
    const response = await fetcher(origin + "/api/v1/commands", {
      method: "POST",
      headers: {
        Cookie: cookie,
        Origin: origin,
        "Content-Type": "application/json",
        "Idempotency-Key": operation.key,
        ...(operation.expected_revision !== undefined
          ? { "If-Match": String(operation.expected_revision) }
          : {}),
      },
      body: JSON.stringify({ command: name, input: operation.input }),
      redirect: "error",
      signal: AbortSignal.timeout(120000),
    });
    const body = object(await response.json());
    if (!response.ok)
      throw new Error("CUTOVER_COMMAND_FAILED_" + response.status);
    operation.result = object(body.data);
    operation.status = "confirmed";
    await save();
    return operation.result;
  };
  for (let index = 0; index < batches.length; index++) {
    // Every new batch is previewed against the global work state AFTER the prior
    // batch's ACK. An attempted batch must retain its exact original preview.
    await previewBatch(index, index > 0);
    const operation = journal.batches[index];
    if (!operation.preview_id)
      throw new Error("CUTOVER_ORIGINAL_PREVIEW_REQUIRED");
    await command(
      "time_entry_import_commit",
      { preview_id: operation.preview_id },
      operation,
    );
  }
  // Existing source configuration is matched by its deterministic canonical feed identity.
  const calendarSources = await query("calendar_sync_status");
  const existingSources = Array.isArray(calendarSources.items)
    ? calendarSources.items.map(object)
    : [];
  for (let index = 0; index < feeds.length; index++) {
    const feed = feeds[index],
      operation = journal.feeds[index];
    if (operation.status === "confirmed") continue;
    const external =
      "feed:" +
      createHash("sha256").update(JSON.stringify(feed.url)).digest("hex");
    const canonicalSourceId =
      "CS-" + digest([ownerId, "ical", external]).slice(0, 40);
    const existing = existingSources.find(
      (source) => source.source_id === canonicalSourceId,
    );
    // Only a retained journal result proves a prior intent succeeded. Otherwise the
    // canonical command is allowed to report a reviewable revision conflict.
    await command(
      "calendar_source_configure",
      {
        provider: "ical",
        title: String(feed.name ?? "Imported calendar"),
        timezone: "Europe/Berlin",
        url: feed.url,
        ...(existing ? { source_id: existing.source_id } : {}),
      },
      operation,
      existing ? Number(existing.revision) : undefined,
    );
  }
  const configuredIds = journal.feeds.map((operation) =>
    String(operation.result?.entity_id ?? ""),
  );
  if (configuredIds.length)
    await command(
      "calendar_sync_request",
      { source_ids: configuredIds },
      journal.sync,
    );
  const readAll = async (operation: string) => {
    const items: ObjectValue[] = [];
    let cursor: string | null = null;
    do {
      const page = await query(operation, {
        limit: 200,
        ...(cursor ? { cursor } : {}),
      });
      if (!Array.isArray(page.items))
        throw new Error("CUTOVER_READBACK_INVALID");
      items.push(...page.items.map(object));
      cursor = typeof page.next_cursor === "string" ? page.next_cursor : null;
      if (items.length > 50000)
        throw new Error("CUTOVER_READBACK_BOUND_EXCEEDED");
    } while (cursor);
    return items;
  };
  const [actualEntries, actualDrafts, actualSources] = await Promise.all([
    readAll("time_entry_export"),
    readAll("time_draft_list"),
    query("calendar_sync_status"),
  ]);
  const entryFields = [
      "entry_id",
      "employer",
      "starts_at",
      "ends_at",
      "description",
      "task_id",
      "reporting_policy",
      "reported_minutes",
      "legacy_metadata",
    ],
    draftFields = [
      "draft_id",
      "employer",
      "date",
      "start",
      "end",
      "end_next_day",
      "description",
      "legacy_metadata",
    ];
  const equal = (
    expected: ObjectValue,
    actual: ObjectValue,
    fields: string[],
  ) =>
    fields.every((field) =>
      field === "legacy_metadata"
        ? digest(Object.entries(object(expected[field])).sort()) ===
          digest(Object.entries(object(actual[field])).sort())
        : expected[field] === actual[field],
    );
  if (
    !prepared.entries.every((entry) =>
      actualEntries.some((actual) => equal(entry, actual, entryFields)),
    ) ||
    !prepared.drafts.every((draft) =>
      actualDrafts.some((actual) => equal(draft, actual, draftFields)),
    )
  )
    throw new Error("CUTOVER_RECONCILIATION_MISMATCH");
  const sourceItems = Array.isArray(actualSources.items)
    ? actualSources.items.map(object)
    : [];
  if (
    !configuredIds.every(
      (id) =>
        id &&
        sourceItems.some(
          (source) => source.source_id === id && source.enabled === true,
        ),
    )
  )
    throw new Error("CUTOVER_FEED_RECONCILIATION_MISMATCH");
  const synchronizedFeeds = configuredIds.filter((id) =>
    sourceItems.some(
      (source) =>
        source.source_id === id &&
        source.status === "connected" &&
        object(source.coverage ?? {}).complete === true,
    ),
  ).length;
  journal.reconciliation = {
    verified: true,
    observed_at: new Date().toISOString(),
    entries_verified: prepared.entries.length,
    drafts_verified: prepared.drafts.length,
    feeds_verified: feeds.length,
    feeds_synchronized: synchronizedFeeds,
    source_written: false,
  };
  journal.status = "verified";
  await save();
  return publicReceipt(
    journal,
    legacyEntries.length,
    prepared.entries.length,
    prepared.drafts.length,
  );
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  workplannerCutover(process.argv.slice(2))
    .then((receipt) => console.log(JSON.stringify(receipt)))
    .catch((error: unknown) => {
      const code =
        error instanceof Error && /^CUTOVER_[A-Z0-9_]+$/.test(error.message)
          ? error.message
          : "CUTOVER_FAILED_OR_UNCERTAIN_RETAIN_JOURNAL";
      console.error(
        code +
          "; no source data or credentials emitted; retain the journal for an identical retry",
      );
      process.exitCode = 1;
    });
}
