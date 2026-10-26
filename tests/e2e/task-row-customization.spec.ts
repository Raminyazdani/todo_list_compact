import {
  test,
  expect,
  type APIRequestContext,
  type APIResponse,
  type Locator,
  type Page,
  type Route,
} from "@playwright/test";
import { mkdir, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  withPrivateFile,
  writeExclusivePrivateJson,
  replacePinnedContents,
} from "../../scripts/ops/private-paths.mjs";
import type { MutationResult, PageDTO, TaskDTO } from "../../shared/contracts";

// This suite writes synthetic fixtures through the real authenticated REST
// boundary. Remote execution requires an explicit production proof opt-in and
// private artifact directories; fixtures never refer to the owner's real rows.
const origin = process.env.E2E_BASE_URL ?? "http://localhost:3000";
const credentialsPath = process.env.E2E_CREDENTIALS_PATH;
const local = ["localhost", "127.0.0.1", "[::1]"].includes(
  new URL(origin).hostname,
);
const productionProof =
  process.env.RUN_TASK_ROW_PRODUCTION_PROOF === "1" &&
  origin === "https://ramin-life-os.vercel.app";
type RowMode = "hidden" | "display" | "edit";
interface RowConfig {
  schema_version: 1;
  fields: { id: string; mode: RowMode }[];
}
interface Preferences {
  revision: number;
  settings: Record<string, unknown>;
}
interface SavedView {
  view_id: string;
  title: string;
  revision: number;
  configuration: Record<string, unknown>;
}
interface WireWrite {
  command: string;
  input: Record<string, unknown>;
  key: string | undefined;
  revision: string | undefined;
}
interface CommandJournal {
  path: string;
  persist: Promise<unknown>;
  pending: Promise<unknown>[];
  document: {
    format: string;
    origin: string;
    test: string;
    owner_id: string;
    actor_id: string;
    original_preferences?: Preferences;
    cleanup_complete?: boolean;
    writes: (WireWrite & {
      attempts: number;
      state: "attempted" | "confirmed" | "rejected" | "unconfirmed";
      http_status?: number;
      acknowledgement?: unknown;
    })[];
  };
}
const editableFields = [
  "title",
  "priority",
  "status",
  "project_id",
  "category",
  "start_date",
  "due_date",
  "due_at",
  "timezone",
  "estimated_minutes",
  "next_action",
  "waiting_for",
  "notes",
  "source_reference",
];
const config = (...fields: [string, RowMode][]): RowConfig => ({
  schema_version: 1,
  fields: fields.map(([id, mode]) => ({ id, mode })),
});
const allEditable = config(
  ...editableFields.map((id): [string, RowMode] => [id, "edit"]),
);
const defaultTestConfig = config(
  ["title", "display"],
  ["priority", "edit"],
  ["status", "edit"],
  ["due_date", "edit"],
  ["notes", "edit"],
);
let originalPreferences: Preferences | undefined;
let createdTaskIds: string[] = [];
let createdProjectIds: string[] = [];
let screenshotDirectory: string | undefined;
let activeJournal: CommandJournal | undefined;
let nextReadSlot = 0;
let readReservations = Promise.resolve();
let currentReadCounts = new Map<string, number>();
const suiteReadMinutes = new Map<number, number>();
let currentSessionReads = { count: 0 };
const suiteSessionMinutes = new Map<number, number>();

// The authenticated API allows 600 reads per actor per fixed minute. Fast CI
// PostgreSQL can compress these write-heavy scenarios into one bucket. Reserve
// only half that capacity and leave headroom for the surrounding browser suite.
// This delays reads before dispatch; a 429 still fails and no write is retried.
function reserveRead(operation: string, counts = currentReadCounts) {
  const reservation = readReservations.then(async () => {
    const delay = nextReadSlot - Date.now();
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    // Space actual dispatch times, so a slow event loop cannot release a
    // backlog of old timer reservations as one burst into the next bucket.
    nextReadSlot = Date.now() + 200;
    counts.set(operation, (counts.get(operation) ?? 0) + 1);
    const minute = Math.floor(Date.now() / 60000);
    suiteReadMinutes.set(minute, (suiteReadMinutes.get(minute) ?? 0) + 1);
  });
  readReservations = reservation;
  return reservation;
}

async function pacePageReads(page: Page) {
  const counts = currentReadCounts;
  const sessions = currentSessionReads;
  page.on("request", (request) => {
    if (
      request.method() !== "GET" ||
      new URL(request.url()).pathname !== "/api/auth/get-session"
    )
      return;
    sessions.count++;
    const minute = Math.floor(Date.now() / 60000);
    suiteSessionMinutes.set(minute, (suiteSessionMinutes.get(minute) ?? 0) + 1);
  });
  await page.route("**/api/v1/query**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/api/v1/query") {
      const operation =
        request.method() === "POST"
          ? request.postDataJSON().operation
          : url.searchParams.get("operation");
      await reserveRead(
        typeof operation === "string" ? operation : "unknown",
        counts,
      );
    }
    await route.continue();
  });
}

test.describe.configure({ mode: "serial" });
test.setTimeout(150000);

function persistJournal(journal: CommandJournal) {
  const bytes = JSON.stringify(journal.document, null, 2) + "\n";
  journal.persist = journal.persist.then(() =>
    withPrivateFile(journal.path, (file) => replacePinnedContents(file, bytes)),
  );
  return journal.persist;
}

async function retainIntent(value: WireWrite, journal = activeJournal) {
  if (!journal) return;
  if (!value.key)
    throw new Error("A retained write must have an idempotency key.");
  const previous = journal.document.writes.find(
    (item) => item.key === value.key,
  );
  if (previous) {
    expect({
      command: previous.command,
      input: previous.input,
      revision: previous.revision,
    }).toEqual({
      command: value.command,
      input: value.input,
      revision: value.revision,
    });
    previous.attempts++;
  } else
    journal.document.writes.push({ ...value, attempts: 1, state: "attempted" });
  await persistJournal(journal);
}

async function retainAcknowledgement(
  key: string | undefined,
  status: number,
  body: unknown,
  journal = activeJournal,
) {
  if (!journal || !key) return;
  const intent = journal.document.writes.find((item) => item.key === key);
  if (!intent) throw new Error("Acknowledgement has no retained write intent.");
  intent.http_status = status;
  intent.acknowledgement = body;
  const acknowledgement = (body as { data?: Partial<MutationResult> } | null)
    ?.data;
  const valid =
    acknowledgement &&
    typeof acknowledgement.operation_id === "string" &&
    typeof acknowledgement.audit_event_id === "string" &&
    typeof acknowledgement.entity_id === "string" &&
    Number.isInteger(acknowledgement.version) &&
    Number(acknowledgement.version) >= 1;
  intent.state =
    status >= 200 && status < 300 && valid
      ? "confirmed"
      : status >= 400 && status < 500 && status !== 408
        ? "rejected"
        : "unconfirmed";
  await persistJournal(journal);
}

async function journalPageCommands(page: Page) {
  const journal = activeJournal;
  if (!journal) return;
  await page.route("**/api/v1/commands", async (route) => {
    await retainIntent(wire(route), journal);
    await route.continue();
  });
  page.on("response", (response) => {
    const request = response.request();
    if (
      request.method() !== "POST" ||
      new URL(response.url()).pathname !== "/api/v1/commands"
    )
      return;
    // A response can arrive during teardown; the closure retains this test's
    // exact private journal instead of accidentally using the next test's one.
    journal.pending.push(
      response
        .json()
        .catch(() => undefined)
        .then((body) => {
          // An unreadable ACK leaves the durable intent as attempted. A private
          // journal persistence failure still fails cleanup instead of being hidden.
          if (body !== undefined)
            return retainAcknowledgement(
              request.headers()["idempotency-key"],
              response.status(),
              body,
              journal,
            );
        }),
    );
  });
}

async function read<T>(
  request: APIRequestContext,
  operation: string,
  input: Record<string, unknown> = {},
): Promise<T> {
  await reserveRead(operation);
  const response = await request.get(
    `${origin}/api/v1/query?${new URLSearchParams({ operation, input: JSON.stringify(input) })}`,
  );
  const body = await response.json();
  expect(
    response.ok(),
    `${operation}: HTTP ${response.status()} ${body.error?.code ?? ""}`,
  ).toBeTruthy();
  return body.data as T;
}

async function write(
  request: APIRequestContext,
  command: string,
  input: Record<string, unknown>,
  revision?: number,
): Promise<MutationResult> {
  const key = crypto.randomUUID();
  await retainIntent({
    command,
    input,
    key,
    revision: revision === undefined ? undefined : String(revision),
  });
  const response = await request.post(`${origin}/api/v1/commands`, {
    headers: {
      Origin: origin,
      "Idempotency-Key": key,
      ...(revision === undefined ? {} : { "If-Match": String(revision) }),
    },
    data: { command, input },
  });
  const body = await response.json();
  await retainAcknowledgement(key, response.status(), body);
  expect(
    response.ok(),
    `${command}: HTTP ${response.status()} ${body.error?.code ?? ""}`,
  ).toBeTruthy();
  expect(body.data).toMatchObject({
    operation_id: expect.any(String),
    audit_event_id: expect.any(String),
    entity_id: expect.any(String),
    version: expect.any(Number),
  });
  return body.data as MutationResult;
}

async function task(request: APIRequestContext, task_id: string) {
  return read<TaskDTO>(request, "task_get", { task_id });
}

async function createTask(
  request: APIRequestContext,
  title: string,
  input: Record<string, unknown> = {},
) {
  const result = await write(request, "task_create", {
    title,
    status: "Next",
    priority: "Normal",
    ...input,
  });
  createdTaskIds.push(result.entity_id);
  return task(request, result.entity_id);
}

async function layouts(
  request: APIRequestContext,
  list: RowConfig = defaultTestConfig,
  tree: RowConfig = defaultTestConfig,
) {
  const before = await read<Preferences>(request, "preferences_get");
  await write(
    request,
    "preferences_update",
    { settings: { task_row_layouts: { list, tree } } },
    before.revision,
  );
}

async function signIn(request: APIRequestContext) {
  const credentials = await withPrivateFile(credentialsPath!, async (file) =>
    JSON.parse(await file.readFile("utf8")),
  );
  let response: APIResponse | undefined;
  let waited = 0;
  for (let attempt = 0; attempt < 3; attempt++) {
    response = await request.post(`${origin}/api/auth/sign-in/email`, {
      headers: { Origin: origin },
      data: { email: credentials.email, password: credentials.password },
    });
    if (response.status() !== 429 || attempt === 2) break;
    const headers = response.headers();
    const value = headers["x-retry-after"] ?? headers["retry-after"];
    const seconds = value
      ? Number.isFinite(Number(value))
        ? Number(value)
        : (Date.parse(value) - Date.now()) / 1000
      : NaN;
    const delay = Math.ceil(seconds * 1000);
    if (!Number.isFinite(delay) || delay < 0 || waited + delay > 30000) break;
    waited += delay;
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
  expect(response?.ok(), "Isolated synthetic owner sign-in").toBeTruthy();
  const identity = await read<{ owner_id: string; actor_id: string }>(
    request,
    "whoami",
  );
  if (
    productionProof &&
    (credentials.origin !== origin ||
      typeof credentials.user_id !== "string" ||
      typeof credentials.owner_id !== "string")
  )
    throw new Error(
      "Production credentials require exact origin, owner and actor pins.",
    );
  if (credentials.user_id) expect(identity.actor_id).toBe(credentials.user_id);
  if (credentials.owner_id)
    expect(identity.owner_id).toBe(credentials.owner_id);
  return identity;
}

function row(page: Page, taskId: string) {
  return page.locator(`[data-task-row="${taskId}"]`);
}

function field(page: Page, taskId: string, fieldId: string) {
  return row(page, taskId).locator(`[data-row-field="${fieldId}"]`);
}

async function openTasks(page: Page, search: string, view = "list") {
  await page.goto(`/tasks?${new URLSearchParams({ search, view })}`);
  await expect(page.locator(".save-status")).toContainText("Server connected", {
    timeout: 30000,
  });
}

async function openEditor(page: Page, taskId: string, fieldId: string) {
  const control = field(page, taskId, fieldId);
  const button = control.getByRole("button").first();
  if (await button.count()) await button.click();
  else await control.click();
  const editor = control.getByTestId("task-field-editor");
  await expect(editor).toBeVisible();
  return editor;
}

async function saveEditor(editor: Locator) {
  await editor.getByRole("button", { name: /^(Save|ثبت)$/ }).click();
}

async function fillField(
  page: Page,
  request: APIRequestContext,
  taskId: string,
  fieldId: string,
  value: string,
  expected: unknown = value,
) {
  const editor = await openEditor(page, taskId, fieldId);
  await editor
    .locator("input:not([type=hidden]), textarea")
    .first()
    .fill(value);
  await saveEditor(editor);
  await expect
    .poll(async () => (await task(request, taskId))[fieldId as keyof TaskDTO])
    .toEqual(expected);
}

async function selectField(
  page: Page,
  request: APIRequestContext,
  taskId: string,
  fieldId: string,
  value: string,
  expected: unknown = value,
) {
  const editor = await openEditor(page, taskId, fieldId);
  await editor.locator("select").first().selectOption(value);
  await expect
    .poll(async () => (await task(request, taskId))[fieldId as keyof TaskDTO])
    .toEqual(expected);
}

function wire(route: Route): WireWrite {
  const request = route.request();
  const body = request.postDataJSON();
  const headers = request.headers();
  return {
    command: body.command,
    input: body.input,
    key: headers["idempotency-key"],
    revision: headers["if-match"],
  };
}

test.beforeEach(async ({ request, context, page }, testInfo) => {
  test.skip(
    !credentialsPath || (!local && !productionProof),
    "Requires isolated staging or an explicit exact-origin production proof.",
  );
  originalPreferences = undefined;
  activeJournal = undefined;
  currentReadCounts = new Map();
  currentSessionReads = { count: 0 };
  createdTaskIds = [];
  createdProjectIds = [];
  await pacePageReads(page);
  const identity = await signIn(request);
  if (productionProof) {
    const path = testInfo.outputPath("task-row-command-journal.json");
    await mkdir(dirname(path), { recursive: true });
    const document: CommandJournal["document"] = {
      format: "ramin-life-os-synthetic-row-proof/1",
      origin,
      test: testInfo.title,
      ...identity,
      writes: [],
    };
    await writeExclusivePrivateJson(path, document);
    activeJournal = { path, document, persist: Promise.resolve(), pending: [] };
    await journalPageCommands(page);
  }
  originalPreferences = await read<Preferences>(request, "preferences_get");
  if (activeJournal) {
    activeJournal.document.original_preferences = originalPreferences;
    await persistJournal(activeJournal);
  }
  await write(
    request,
    "preferences_update",
    { settings: { language: "en", theme: "dark" } },
    originalPreferences.revision,
  );
  await layouts(request);
  await context.addCookies((await request.storageState()).cookies);
});

test.afterEach(async ({ request }) => {
  if (!originalPreferences) return;
  // Each fixture is independently archived. Never change another suite's tasks.
  for (const id of createdTaskIds.reverse()) {
    const current = await task(request, id);
    if (!current.archived_at)
      await write(request, "task_archive", { task_id: id }, current.revision);
  }
  for (const id of createdProjectIds) {
    const current = await read<{
      revision: number;
      archived_at: string | null;
    }>(request, "project_get", { project_id: id });
    if (!current.archived_at)
      await write(
        request,
        "project_archive",
        { project_id: id },
        current.revision,
      );
  }
  const current = await read<Preferences>(request, "preferences_get");
  const originalLayouts = originalPreferences.settings.task_row_layouts as
    { list?: RowConfig; tree?: RowConfig } | undefined;
  await write(
    request,
    "preferences_update",
    {
      settings: {
        language: originalPreferences.settings.language ?? "fa",
        theme: originalPreferences.settings.theme ?? "dark",
        // Layout updates deep-merge by view. Explicitly remove a view absent
        // from the baseline instead of accidentally retaining our test layout.
        task_row_layouts: originalLayouts
          ? {
              list: originalLayouts.list ?? null,
              tree: originalLayouts.tree ?? null,
            }
          : null,
      },
    },
    current.revision,
  );
  if (activeJournal) {
    await Promise.all(activeJournal.pending);
    for (const id of createdTaskIds)
      expect((await task(request, id)).archived_at).not.toBeNull();
    const restored = await read<Preferences>(request, "preferences_get");
    expect(restored.settings.task_row_layouts).toEqual(
      originalPreferences.settings.task_row_layouts,
    );
    expect(restored.settings.language).toBe(
      originalPreferences.settings.language ?? "fa",
    );
    expect(restored.settings.theme).toBe(
      originalPreferences.settings.theme ?? "dark",
    );
    activeJournal.document.cleanup_complete = true;
    await persistJournal(activeJournal);
  }
  console.log(
    "TASK_ROW_READ_BUDGET",
    JSON.stringify({
      queries: [...currentReadCounts.values()].reduce(
        (sum, count) => sum + count,
        0,
      ),
      operations: Object.fromEntries(
        [...currentReadCounts.entries()].sort(([a], [b]) => a.localeCompare(b)),
      ),
      max_suite_minute: Math.max(0, ...suiteReadMinutes.values()),
      auth_get_session: currentSessionReads.count,
      max_suite_auth_minute: Math.max(0, ...suiteSessionMinutes.values()),
    }),
  );
});

test.beforeAll(async () => {
  if (!productionProof) return;
  const candidate = process.env.E2E_SCREENSHOT_DIRECTORY;
  if (!candidate || !isAbsolute(candidate))
    throw new Error(
      "Production proof requires a private screenshot directory.",
    );
  const canonical = await realpath(candidate);
  const delta = relative(await realpath(process.cwd()), canonical);
  if (
    canonical.toLowerCase() !== resolve(candidate).toLowerCase() ||
    !(await stat(canonical)).isDirectory() ||
    !(isAbsolute(delta) || delta === ".." || delta.startsWith(".." + sep))
  )
    throw new Error("Production screenshots must remain outside public Git.");
  screenshotDirectory = canonical;
});

test("row_smoke_global_settings_apply_to_all_parent_and_child_rows_and_persist_across_contexts", async ({
  page,
  request,
  browser,
}) => {
  const prefix = `SYNTHETIC ROW CONFIG ${crypto.randomUUID().slice(0, 8)}`;
  const parent = await createTask(request, `${prefix} parent`);
  const child = await createTask(request, `${prefix} child`, {
    parent_task_id: parent.task_id,
  });
  const baseline = await Promise.all([
    task(request, parent.task_id),
    task(request, child.task_id),
  ]);
  const before = await read<Preferences>(request, "preferences_get");
  const commands: string[] = [];
  const settingsAttempts: WireWrite[] = [];
  const settingsReceipts: MutationResult[] = [];
  let loseSettingsAcknowledgement = true;
  await page.route("**/api/v1/commands", async (route) => {
    const value = wire(route);
    await retainIntent(value);
    if (value.command !== "preferences_update") {
      await route.continue();
      return;
    }
    settingsAttempts.push(value);
    const response = await route.fetch();
    const acknowledgement = await response.json();
    settingsReceipts.push(acknowledgement.data);
    await retainAcknowledgement(value.key, response.status(), acknowledgement);
    if (loseSettingsAcknowledgement) {
      loseSettingsAcknowledgement = false;
      await route.abort("failed");
    } else await route.fulfill({ response });
  });
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      new URL(request.url()).pathname === "/api/v1/commands"
    )
      commands.push(request.postDataJSON().command);
  });
  await openTasks(page, prefix);
  for (const item of baseline) {
    const selection = row(page, item.task_id).getByRole("checkbox", {
      name: `Select ${item.title}`,
      exact: true,
    });
    await selection.check();
    await expect(selection).toBeChecked();
    await selection.uncheck();
    await expect(field(page, item.task_id, "due_date")).toBeVisible();
    await expect(
      field(page, item.task_id, "priority").getByRole("button"),
    ).toBeVisible();
  }
  await page
    .getByRole("button", { name: "Configure rows", exact: true })
    .click();
  const settings = page.getByRole("dialog", {
    name: "Row settings",
    exact: true,
  });
  await expect(settings).toBeVisible();
  await expect(
    settings
      .getByTestId("row-setting-readiness")
      .locator('option[value="edit"]'),
  ).toBeDisabled();
  await expect(
    settings.getByTestId("row-setting-title").locator('option[value="hidden"]'),
  ).toBeDisabled();
  await settings
    .getByTestId("row-setting-priority")
    .getByRole("combobox")
    .selectOption("display");
  await settings
    .getByTestId("row-setting-due_date")
    .getByRole("combobox")
    .selectOption("hidden");
  const orderedSettings = settings.locator('[data-testid^="row-setting-"]');
  const orderBefore = await orderedSettings.evaluateAll((elements) =>
    elements.map((element) => element.getAttribute("data-testid")),
  );
  await settings
    .getByTestId("row-setting-notes")
    .getByRole("button", { name: /Move up|بالا/ })
    .click();
  const orderAfter = await orderedSettings.evaluateAll((elements) =>
    elements.map((element) => element.getAttribute("data-testid")),
  );
  expect(orderAfter.indexOf("row-setting-notes")).toBeLessThan(
    orderBefore.indexOf("row-setting-notes"),
  );
  await settings
    .getByRole("button", { name: "Save row settings", exact: true })
    .click();
  await expect(
    settings.getByRole("button", { name: "Recover this save", exact: true }),
  ).toBeVisible();
  await expect(
    settings.getByTestId("row-setting-priority").getByRole("combobox"),
  ).toBeDisabled();
  expect((await read<Preferences>(request, "preferences_get")).revision).toBe(
    before.revision + 1,
  );
  await settings
    .getByRole("button", { name: "Recover this save", exact: true })
    .click();
  await expect(settings).not.toBeVisible();
  expect(settingsAttempts).toHaveLength(2);
  expect(settingsAttempts[1]).toEqual(settingsAttempts[0]);
  expect(settingsReceipts[1]).toMatchObject({
    replayed: true,
    operation_id: settingsReceipts[0].operation_id,
    audit_event_id: settingsReceipts[0].audit_event_id,
    version: before.revision + 1,
  });
  const persisted = await read<Preferences>(request, "preferences_get");
  expect(persisted.revision).toBe(before.revision + 1);
  const savedLayouts = persisted.settings.task_row_layouts as {
    list: RowConfig;
    tree: RowConfig;
  };
  expect(savedLayouts.list.fields).toEqual(
    expect.arrayContaining([
      { id: "priority", mode: "display" },
      { id: "due_date", mode: "hidden" },
    ]),
  );
  expect(savedLayouts.tree).toEqual(defaultTestConfig);
  const withoutLayouts = (settings: Record<string, unknown>) =>
    Object.fromEntries(
      Object.entries(settings).filter(([key]) => key !== "task_row_layouts"),
    );
  expect(withoutLayouts(persisted.settings)).toEqual(
    withoutLayouts(before.settings),
  );
  expect(commands).toEqual(["preferences_update", "preferences_update"]);
  for (const item of baseline) {
    await expect(field(page, item.task_id, "due_date")).toHaveCount(0);
    await expect(
      field(page, item.task_id, "priority").getByRole("button"),
    ).toHaveCount(0);
    expect(await task(request, item.task_id)).toEqual(item);
  }
  await page.reload();
  await expect(field(page, parent.task_id, "due_date")).toHaveCount(0);
  const other = await browser.newContext({
    baseURL: origin,
    storageState: await request.storageState(),
  });
  try {
    const second = await other.newPage();
    await pacePageReads(second);
    await journalPageCommands(second);
    await openTasks(second, prefix);
    await expect(field(second, child.task_id, "priority")).toBeVisible();
    await expect(
      field(second, child.task_id, "priority").getByRole("button"),
    ).toHaveCount(0);
    await second
      .getByRole("button", { name: /^(نمای درختی|Tree view)$/ })
      .click();
    await expect(field(second, parent.task_id, "due_date")).toBeVisible();
    // Tree retains its own common layout; both levels use it.
    await expect(field(second, child.task_id, "due_date")).toBeVisible();
    const parentBranch = row(second, parent.task_id).locator("..");
    await parentBranch
      .getByRole("button", { name: /^(Collapse branch|بستن شاخهٔ)/ })
      .click();
    await expect(row(second, child.task_id)).toHaveCount(0);
    await parentBranch
      .getByRole("button", { name: /^(Expand branch|بازکردن شاخهٔ)/ })
      .click();
    await expect(row(second, child.task_id)).toBeVisible();
    await second
      .getByRole("button", { name: "Configure rows", exact: true })
      .click();
    const treeSettings = second.getByRole("dialog", {
      name: "Row settings",
      exact: true,
    });
    await treeSettings
      .getByTestId("row-setting-priority")
      .getByRole("combobox")
      .selectOption("hidden");
    await treeSettings
      .getByRole("button", { name: "Save row settings", exact: true })
      .click();
    await expect(treeSettings).not.toBeVisible();
    for (const item of baseline) {
      await expect(field(second, item.task_id, "priority")).toHaveCount(0);
      expect(await task(request, item.task_id)).toEqual(item);
    }
    expect(
      (
        (await read<Preferences>(request, "preferences_get")).settings
          .task_row_layouts as { list: RowConfig }
      ).list,
    ).toEqual(savedLayouts.list);
    await second
      .getByRole("button", { name: "Configure rows", exact: true })
      .click();
    await treeSettings
      .getByRole("button", { name: "Reset this view default", exact: true })
      .click();
    await expect(treeSettings).not.toBeVisible();
    await expect(
      field(second, child.task_id, "priority").getByRole("button"),
    ).toBeVisible();
    expect(
      (
        (await read<Preferences>(request, "preferences_get")).settings
          .task_row_layouts as { tree?: RowConfig }
      ).tree,
    ).toBeUndefined();
  } finally {
    await other.close();
  }
});

test("row_smoke_individual_edits_send_only_the_delta_and_preserve_independent_dates_and_other_tasks", async ({
  page,
  request,
}) => {
  await layouts(request, allEditable);
  const prefix = `SYNTHETIC ROW FIELDS ${crypto.randomUUID().slice(0, 8)}`;
  const a = await createTask(request, `${prefix} A`, {
    due_at: "2031-02-06T08:07:43Z",
    timezone: "Europe/Berlin",
    source_reference: "Synthetic original source",
    legacy_metadata: { fixture: "synthetic-row-fields" },
  });
  const b = await createTask(request, `${prefix} B`);
  const writes: WireWrite[] = [];
  await page.route("**/api/v1/commands", async (route) => {
    const value = wire(route);
    await retainIntent(value);
    if (value.input.task_id === a.task_id) writes.push(value);
    await route.continue();
  });
  await openTasks(page, prefix);
  await selectField(page, request, a.task_id, "priority", "Urgent");
  await fillField(page, request, a.task_id, "due_date", "2031-02-05");
  await fillField(page, request, a.task_id, "start_date", "2031-02-01");
  let current = await task(request, a.task_id);
  expect(current.due_at).toBe(a.due_at);
  expect(current.timezone).toBe("Europe/Berlin");
  await fillField(page, request, a.task_id, "due_date", "", null);
  current = await task(request, a.task_id);
  expect(current.start_date).toBe("2031-02-01");
  expect(current.due_at).toBe(a.due_at);
  await fillField(page, request, a.task_id, "start_date", "", null);
  await selectField(page, request, a.task_id, "category", "Research");
  await fillField(page, request, a.task_id, "estimated_minutes", "0", 0);
  await fillField(page, request, a.task_id, "estimated_minutes", "", null);
  await fillField(
    page,
    request,
    a.task_id,
    "next_action",
    "گام بعدی Synthetic next action",
  );
  await fillField(
    page,
    request,
    a.task_id,
    "waiting_for",
    "Synthetic reviewer",
  );
  await fillField(
    page,
    request,
    a.task_id,
    "notes",
    "Synthetic notes\nخط دوم با متن <script>never run</script>",
  );
  await fillField(
    page,
    request,
    a.task_id,
    "source_reference",
    "Synthetic source\nhttps://example.invalid/reference",
  );
  const project = await write(request, "project_create", {
    title: `${prefix} project`,
  });
  createdProjectIds.push(project.entity_id);
  // A new context refresh reads the project inventory; existing task fields are
  // not replaced with a stale form snapshot when selecting the project.
  await page.reload();
  await selectField(page, request, a.task_id, "project_id", project.entity_id);
  await selectField(page, request, a.task_id, "project_id", "", null);
  let invalid = await openEditor(page, a.task_id, "title");
  await invalid.locator('input[name="title"]').fill("   ");
  const beforeInvalid = writes.length;
  await saveEditor(invalid);
  await expect(invalid.getByRole("alert")).toContainText("Title is required");
  expect(writes).toHaveLength(beforeInvalid);
  await invalid.getByRole("button", { name: "Cancel", exact: true }).click();
  invalid = await openEditor(page, a.task_id, "estimated_minutes");
  await invalid.locator('input[name="estimated_minutes"]').fill("-1");
  await saveEditor(invalid);
  expect(
    await invalid
      .locator('input[name="estimated_minutes"]')
      .evaluate((input) => (input as HTMLInputElement).validity.rangeUnderflow),
  ).toBe(true);
  expect(writes).toHaveLength(beforeInvalid);
  await invalid.getByRole("button", { name: "Cancel", exact: true }).click();
  const title = `${prefix} A edited independently`;
  await fillField(page, request, a.task_id, "title", title);
  current = await task(request, a.task_id);
  expect(current.status).toBe("Next");
  expect(current.legacy_metadata).toEqual(a.legacy_metadata);
  expect(current.parent_task_id).toBeNull();
  expect(await task(request, b.task_id)).toEqual(b);
  for (const value of writes) {
    expect(value.command).toBe("task_update");
    expect(Object.keys(value.input)).toHaveLength(2);
    expect(value.input.task_id).toBe(a.task_id);
    expect(value.key).toBeTruthy();
    expect(Number(value.revision)).toBeGreaterThanOrEqual(a.revision);
  }
  expect(writes.map((value) => Number(value.revision))).toEqual(
    Array.from({ length: writes.length }, (_, index) => a.revision + index),
  );
  await row(page, a.task_id)
    .getByRole("button", { name: title, exact: true })
    .click();
  await expect(
    page
      .getByRole("dialog")
      .filter({ has: page.getByRole("heading", { name: title, exact: true }) }),
  ).toBeVisible();
});

test("saved_view_legacy_filters_and_configuration_survive_a_revision_guarded_common_row_override", async ({
  page,
  request,
}) => {
  test.skip(
    !local,
    "SavedView creation has no canonical archive API; production proof never creates view clutter.",
  );
  const prefix = `SYNTHETIC ROW VIEW ${crypto.randomUUID().slice(0, 8)}`;
  const a = await createTask(request, `${prefix} A`, { priority: "High" });
  const b = await createTask(request, `${prefix} B`, { priority: "Low" });
  const configuration = {
    filters: { search: prefix, priority: "High", status: "Next" },
    layout: "list",
    density: "compact",
    synthetic_legacy_option: { preserved: true },
  };
  const created = await write(request, "saved_view_create", {
    title: prefix,
    configuration,
  });
  await openTasks(page, prefix);
  await page
    .getByRole("combobox", { name: "Saved views", exact: true })
    .selectOption(created.entity_id);
  await expect(row(page, a.task_id)).toBeVisible();
  await expect(row(page, b.task_id)).toHaveCount(0);
  // A legacy SavedView without row_fields inherits the active list layout.
  await expect(
    field(page, a.task_id, "priority").getByRole("button"),
  ).toBeVisible();
  const observed: WireWrite[] = [];
  await page.route("**/api/v1/commands", async (route) => {
    await retainIntent(wire(route));
    if (wire(route).command === "saved_view_update") observed.push(wire(route));
    await route.continue();
  });
  await page
    .getByRole("button", { name: "Configure rows", exact: true })
    .click();
  const settings = page.getByRole("dialog", {
    name: "Row settings",
    exact: true,
  });
  const destination = settings.getByRole("combobox", {
    name: "Save row settings to",
    exact: true,
  });
  await destination.selectOption("saved_view");
  await settings
    .getByTestId("row-setting-priority")
    .getByRole("combobox")
    .selectOption("display");
  await settings
    .getByRole("button", { name: "Save row settings", exact: true })
    .click();
  await expect(settings).not.toBeVisible();
  let view = (
    await read<PageDTO<SavedView>>(request, "saved_view_list")
  ).items.find((item) => item.view_id === created.entity_id)!;
  expect(view.revision).toBe(created.version + 1);
  expect(view.configuration).toMatchObject(configuration);
  expect((view.configuration.row_fields as RowConfig).fields).toContainEqual({
    id: "priority",
    mode: "display",
  });
  expect(observed).toHaveLength(1);
  expect(observed[0].revision).toBe(String(created.version));
  await page.reload();
  await page
    .getByRole("combobox", { name: "Saved views", exact: true })
    .selectOption(created.entity_id);
  await expect(
    field(page, a.task_id, "priority").getByRole("button"),
  ).toHaveCount(0);
  await expect(row(page, b.task_id)).toHaveCount(0);
  await page
    .getByRole("button", { name: "Configure rows", exact: true })
    .click();
  await settings
    .getByTestId("row-setting-priority")
    .getByRole("combobox")
    .selectOption("edit");
  const concurrentConfiguration = {
    ...view.configuration,
    synthetic_legacy_option: {
      preserved: true,
      changed_in_other_context: true,
    },
  };
  await write(
    request,
    "saved_view_update",
    {
      view_id: view.view_id,
      configuration: concurrentConfiguration,
    },
    view.revision,
  );
  await settings
    .getByRole("button", { name: "Save row settings", exact: true })
    .click();
  await expect(
    settings.getByRole("button", {
      name: "Review latest and keep my draft",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    settings.getByTestId("row-setting-priority").getByRole("combobox"),
  ).toHaveValue("edit");
  view = (
    await read<PageDTO<SavedView>>(request, "saved_view_list")
  ).items.find((item) => item.view_id === created.entity_id)!;
  expect(view.configuration).toEqual(concurrentConfiguration);
  await settings
    .getByRole("button", {
      name: "Review latest and keep my draft",
      exact: true,
    })
    .click();
  await expect(
    settings.getByRole("button", { name: "Save row settings", exact: true }),
  ).toBeEnabled();
  await settings
    .getByRole("button", { name: "Save row settings", exact: true })
    .click();
  await expect(settings).not.toBeVisible();
  view = (
    await read<PageDTO<SavedView>>(request, "saved_view_list")
  ).items.find((item) => item.view_id === created.entity_id)!;
  expect(view.configuration).toMatchObject({
    ...configuration,
    synthetic_legacy_option: concurrentConfiguration.synthetic_legacy_option,
  });
  expect((view.configuration.row_fields as RowConfig).fields).toContainEqual({
    id: "priority",
    mode: "edit",
  });
  // Reset through the actual UI, preserving the concurrent filter/config state.
  await page
    .getByRole("button", { name: "Configure rows", exact: true })
    .click();
  await settings
    .getByRole("button", { name: "Reset this saved view", exact: true })
    .click();
  await expect(settings).not.toBeVisible();
  await expect(
    field(page, a.task_id, "priority").getByRole("button"),
  ).toBeVisible();
  view = (
    await read<PageDTO<SavedView>>(request, "saved_view_list")
  ).items.find((item) => item.view_id === created.entity_id)!;
  expect(view.configuration).toEqual({
    ...configuration,
    synthetic_legacy_option: concurrentConfiguration.synthetic_legacy_option,
  });
  expect(
    (await read<Preferences>(request, "preferences_get")).settings
      .task_row_layouts,
  ).toEqual({ list: defaultTestConfig, tree: defaultTestConfig });
});

test("inline_drafts_survive_background_refresh_and_real_revision_conflicts_without_silent_overwrite", async ({
  page,
  request,
}) => {
  const prefix = `SYNTHETIC ROW CONFLICT ${crypto.randomUUID().slice(0, 8)}`;
  const a = await createTask(request, `${prefix} task`, {
    notes: "Initial synthetic notes",
  });
  await openTasks(page, prefix);
  let editor = await openEditor(page, a.task_id, "notes");
  const draft = "My retained draft\nمتن چندخطی";
  await editor.locator("textarea").fill(draft);
  await page.evaluate(() => window.dispatchEvent(new Event("lifeos:changed")));
  await expect(editor.locator("textarea")).toHaveValue(draft);
  // The row is unmounted by a real search change, then rendered again.
  await page.getByPlaceholder("Search tasks…").fill(`${prefix} absent`);
  await expect(row(page, a.task_id)).toHaveCount(0);
  await page.getByPlaceholder("Search tasks…").fill(prefix);
  await expect(row(page, a.task_id)).toBeVisible();
  editor = page.getByTestId("task-field-editor");
  if (!(await editor.count()))
    editor = await openEditor(page, a.task_id, "notes");
  await expect(editor.locator("textarea")).toHaveValue(draft);
  const external = await task(request, a.task_id);
  await write(
    request,
    "task_update",
    {
      task_id: a.task_id,
      priority: "High",
      notes: "Changed in another authenticated context",
    },
    external.revision,
  );
  await saveEditor(editor);
  await expect(
    field(page, a.task_id, "notes").locator('[data-save-state="conflict"]'),
  ).toBeVisible();
  expect((await task(request, a.task_id)).notes).toBe(
    "Changed in another authenticated context",
  );
  await expect(editor.locator("textarea")).toHaveValue(draft);
  await editor
    .getByRole("button", { name: "Apply my draft", exact: true })
    .click();
  await expect
    .poll(async () => (await task(request, a.task_id)).notes)
    .toBe(draft);
  const actual = await task(request, a.task_id);
  expect(actual.priority).toBe("High");
  expect(actual.revision).toBe(a.revision + 2);
  editor = await openEditor(page, a.task_id, "notes");
  await editor
    .locator("textarea")
    .fill("Draft discarded only by explicit choice");
  await write(
    request,
    "task_update",
    {
      task_id: a.task_id,
      notes: "Explicitly selected server notes",
    },
    actual.revision,
  );
  await saveEditor(editor);
  await expect(
    field(page, a.task_id, "notes").locator('[data-save-state="conflict"]'),
  ).toBeVisible();
  await editor
    .getByRole("button", { name: "Use server value", exact: true })
    .click();
  expect((await task(request, a.task_id)).notes).toBe(
    "Explicitly selected server notes",
  );
  await expect(page.locator('[data-save-state="conflict"]')).toHaveCount(0);
});

test("known_rejection_keeps_the_draft_and_lost_ack_retries_the_exact_committed_intent_once", async ({
  page,
  request,
}) => {
  const prefix = `SYNTHETIC ROW ACK ${crypto.randomUUID().slice(0, 8)}`;
  const a = await createTask(request, `${prefix} task`, {
    notes: "Before rejected request",
  });
  await openTasks(page, prefix);
  let reject = true;
  let loseAck = false;
  const attempts: WireWrite[] = [];
  const receipts: MutationResult[] = [];
  await page.route("**/api/v1/commands", async (route) => {
    const value = wire(route);
    await retainIntent(value);
    if (value.command !== "task_update" || value.input.task_id !== a.task_id) {
      await route.continue();
      return;
    }
    attempts.push(value);
    if (reject) {
      reject = false;
      await route.fulfill({
        status: 400,
        json: {
          error: {
            code: "INVALID_INPUT",
            message: "Synthetic known rejection",
          },
        },
      });
      return;
    }
    const response = await route.fetch();
    const acknowledgement = await response.json();
    receipts.push(acknowledgement.data);
    await retainAcknowledgement(value.key, response.status(), acknowledgement);
    if (loseAck) {
      loseAck = false;
      // The actual canonical server committed; only the browser ACK is lost.
      await route.abort("failed");
      return;
    }
    await route.fulfill({ response });
  });
  let editor = await openEditor(page, a.task_id, "notes");
  const draft = "Retained after a known server rejection";
  await editor.locator("textarea").fill(draft);
  await saveEditor(editor);
  await expect(
    field(page, a.task_id, "notes").locator('[data-save-state="error"]'),
  ).toBeVisible();
  await expect(editor.locator("textarea")).toHaveValue(draft);
  expect((await task(request, a.task_id)).notes).toBe(a.notes);
  await saveEditor(editor);
  await expect
    .poll(async () => (await task(request, a.task_id)).notes)
    .toBe(draft);
  await expect(page.locator('[data-save-state="error"]')).toHaveCount(0);
  const beforeUnknown = await task(request, a.task_id);
  editor = await openEditor(page, a.task_id, "notes");
  const uncertainDraft = "Committed with a deliberately lost acknowledgement";
  await editor.locator("textarea").fill(uncertainDraft);
  loseAck = true;
  await saveEditor(editor);
  await expect(
    field(page, a.task_id, "notes").locator('[data-save-state="unconfirmed"]'),
  ).toBeVisible();
  await expect
    .poll(async () => (await task(request, a.task_id)).notes)
    .toBe(uncertainDraft);
  await page.evaluate(() => window.dispatchEvent(new Event("lifeos:changed")));
  await expect(editor.locator("textarea")).toHaveValue(uncertainDraft);
  await editor
    .getByRole("button", { name: "Recover this save", exact: true })
    .click();
  await expect(
    field(page, a.task_id, "notes").locator('[data-save-state="saved"]'),
  ).toBeVisible();
  await expect.poll(() => receipts.length).toBe(3);
  expect(attempts).toHaveLength(4);
  expect(attempts[2]).toEqual(attempts[3]);
  expect(attempts[2].key).not.toBe(attempts[1].key);
  expect(receipts).toHaveLength(3);
  expect(receipts[2]).toMatchObject({
    operation_id: receipts[1].operation_id,
    audit_event_id: receipts[1].audit_event_id,
    entity_id: a.task_id,
    version: beforeUnknown.revision + 1,
    replayed: true,
  });
  expect((await task(request, a.task_id)).revision).toBe(
    beforeUnknown.revision + 1,
  );
});

test("exact_deadline_zone_only_edits_preserve_seconds_and_require_explicit_DST_resolution", async ({
  page,
  request,
}) => {
  await layouts(request, allEditable);
  const prefix = `SYNTHETIC ROW ZONE ${crypto.randomUUID().slice(0, 8)}`;
  const a = await createTask(request, `${prefix} task`, {
    due_date: "2026-10-24",
    due_at: "2026-08-20T08:07:43Z",
    timezone: "Europe/Berlin",
  });
  const writes: WireWrite[] = [];
  await page.route("**/api/v1/commands", async (route) => {
    await retainIntent(wire(route));
    writes.push(wire(route));
    await route.continue();
  });
  await openTasks(page, prefix);
  await fillField(page, request, a.task_id, "timezone", "Asia/Tehran");
  let current = await task(request, a.task_id);
  expect(current.due_at).toBe(a.due_at);
  expect(current.due_date).toBe("2026-10-24");
  expect(writes[0].input).toEqual({
    task_id: a.task_id,
    timezone: "Asia/Tehran",
  });
  let editor = await openEditor(page, a.task_id, "due_at");
  await editor.locator('input[name="timezone"]').fill("Europe/Berlin");
  await editor.locator('input[name="due_at"]').fill("2026-03-29T02:30:43");
  await saveEditor(editor);
  await expect(editor.getByRole("alert")).toContainText("does not exist");
  expect(writes).toHaveLength(1);
  expect((await task(request, a.task_id)).due_at).toBe(a.due_at);
  await editor.locator('input[name="due_at"]').fill("2026-10-25T02:30:43");
  await saveEditor(editor);
  await expect(editor.getByRole("alert")).toContainText("occurs twice");
  expect(writes).toHaveLength(1);
  await editor.locator('select[name="disambiguation"]').selectOption("later");
  await saveEditor(editor);
  await expect
    .poll(async () => (await task(request, a.task_id)).due_at)
    .toBe("2026-10-25T01:30:43.000Z");
  current = await task(request, a.task_id);
  expect(current.timezone).toBe("Europe/Berlin");
  expect(current.due_date).toBe("2026-10-24");
  editor = await openEditor(page, a.task_id, "due_at");
  await editor.locator('input[name="due_at"]').fill("");
  await saveEditor(editor);
  await expect
    .poll(async () => (await task(request, a.task_id)).due_at)
    .toBeNull();
  expect((await task(request, a.task_id)).due_date).toBe("2026-10-24");
  expect(writes.every((value) => value.command === "task_update")).toBe(true);
});

test("successive_inline_saves_queue_per_task_and_use_the_preceding_confirmed_revision", async ({
  page,
  request,
}) => {
  const prefix = `SYNTHETIC ROW QUEUE ${crypto.randomUUID().slice(0, 8)}`;
  const a = await createTask(request, `${prefix} task`);
  await openTasks(page, prefix);
  const attempts: WireWrite[] = [];
  let acknowledge!: () => void;
  let announce!: () => void;
  const held = new Promise<void>((resolve) => {
    acknowledge = resolve;
  });
  const accepted = new Promise<void>((resolve) => {
    announce = resolve;
  });
  await page.route("**/api/v1/commands", async (route) => {
    const value = wire(route);
    await retainIntent(value);
    if (value.input.task_id !== a.task_id) {
      await route.continue();
      return;
    }
    attempts.push(value);
    if (attempts.length === 1) {
      const response = await route.fetch();
      announce();
      await held;
      await route.fulfill({ response });
    } else await route.continue();
  });
  try {
    const priority = await openEditor(page, a.task_id, "priority");
    await priority.locator('select[name="priority"]').selectOption("High");
    await accepted;
    await expect(
      field(page, a.task_id, "priority").locator('[data-save-state="pending"]'),
    ).toBeVisible();
    const due = await openEditor(page, a.task_id, "due_date");
    await due.locator('input[name="due_date"]').fill("2034-07-12");
    await saveEditor(due);
    await expect(
      field(page, a.task_id, "due_date").locator('[data-save-state="queued"]'),
    ).toBeVisible();
    expect(attempts).toHaveLength(1);
    acknowledge();
    await expect
      .poll(async () => (await task(request, a.task_id)).due_date)
      .toBe("2034-07-12");
    const actual = await task(request, a.task_id);
    expect(actual.priority).toBe("High");
    expect(actual.revision).toBe(a.revision + 2);
    expect(attempts.map((value) => value.revision)).toEqual([
      String(a.revision),
      String(a.revision + 1),
    ]);
    expect(attempts[0].key).not.toBe(attempts[1].key);
  } finally {
    acknowledge();
  }
});

test("inline_statuses_and_metadata_preserve_closed_archived_and_hard_blocked_task_semantics", async ({
  page,
  request,
}) => {
  const prefix = `SYNTHETIC ROW STATUS ${crypto.randomUUID().slice(0, 8)}`;
  const a = await createTask(request, `${prefix} lifecycle`);
  const prerequisite = await createTask(request, `${prefix} prerequisite`);
  const blocked = await createTask(request, `${prefix} blocked`);
  const preview = await read<{ preview_id: string }>(
    request,
    "task_dependency_add_preview",
    {
      task_id: blocked.task_id,
      prerequisites: [{ task_id: prerequisite.task_id, mode: "hard" }],
      operator: "ALL",
    },
  );
  await write(request, "task_dependency_add_commit", {
    preview_id: preview.preview_id,
  });
  const archived = await createTask(request, `${prefix} archived`);
  await write(
    request,
    "task_archive",
    { task_id: archived.task_id },
    archived.revision,
  );
  const archiveBefore = await task(request, archived.task_id);
  await openTasks(page, prefix);
  const editor = await openEditor(page, a.task_id, "status");
  expect(
    await editor
      .locator('select[name="status"] option')
      .evaluateAll((options) =>
        options.map((option) => (option as HTMLOptionElement).value),
      ),
  ).toEqual(["Inbox", "Next", "In progress", "Waiting", "Done", "Cancelled"]);
  await editor.getByRole("button", { name: "Cancel", exact: true }).click();
  for (const status of ["Inbox", "Next", "In progress", "Waiting", "Cancelled"])
    await selectField(page, request, a.task_id, "status", status);
  const cancelled = await task(request, a.task_id);
  await selectField(page, request, a.task_id, "priority", "High");
  expect(await task(request, a.task_id)).toMatchObject({
    status: "Cancelled",
    closed_at: cancelled.closed_at,
  });
  await selectField(page, request, a.task_id, "status", "Next");
  await selectField(page, request, a.task_id, "status", "Done");
  const completed = await task(request, a.task_id);
  await fillField(
    page,
    request,
    a.task_id,
    "notes",
    "Metadata changed while Done",
  );
  expect(await task(request, a.task_id)).toMatchObject({
    status: "Done",
    completed_at: completed.completed_at,
    closed_at: completed.closed_at,
  });
  const blockedBefore = await task(request, blocked.task_id);
  const blockedEditor = await openEditor(page, blocked.task_id, "status");
  await blockedEditor.locator('select[name="status"]').selectOption("Done");
  await expect(
    field(page, blocked.task_id, "status").locator(
      '[data-save-state="blocked"]',
    ),
  ).toBeVisible();
  expect(await task(request, blocked.task_id)).toMatchObject({
    status: "Next",
    readiness: "blocked",
    revision: blockedBefore.revision,
  });
  // No reason was provided and no override was accepted.
  const override = page.getByRole("dialog", {
    name: "Unfinished prerequisites",
    exact: true,
  });
  await expect(override).toBeVisible();
  await override
    .getByRole("button", { name: "Close / بستن", exact: true })
    .click();
  expect((await task(request, blocked.task_id)).status).toBe("Next");
  await saveEditor(blockedEditor);
  await expect(override).toBeVisible();
  const reason =
    "Synthetic browser owner explicitly accepts this unfinished prerequisite";
  await override.getByLabel("Your reason", { exact: true }).fill(reason);
  await override
    .getByRole("button", {
      name: "Confirm override and record in history",
      exact: true,
    })
    .click();
  await expect
    .poll(async () => (await task(request, blocked.task_id)).status)
    .toBe("Done");
  await expect(override).not.toBeVisible();
  await expect(
    field(page, blocked.task_id, "status").locator('[data-save-state="saved"]'),
  ).toBeVisible();
  await expect(
    field(page, blocked.task_id, "status").locator(
      '[data-save-state="blocked"]',
    ),
  ).toHaveCount(0);
  const acceptedOverride = await task(request, blocked.task_id);
  expect(acceptedOverride.revision).toBe(blockedBefore.revision + 1);
  expect(acceptedOverride.activity).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        event_type: "task.override_blocker",
        channel: "UI",
        reason,
      }),
    ]),
  );
  expect((await task(request, prerequisite.task_id)).status).toBe("Next");
  await page.getByRole("button", { name: "Archived", exact: true }).click();
  await expect(row(page, archived.task_id)).toBeVisible();
  await selectField(page, request, archived.task_id, "priority", "Low");
  expect(await task(request, archived.task_id)).toMatchObject({
    archived_at: archiveBefore.archived_at,
    status: archiveBefore.status,
    title: archiveBefore.title,
  });
});

test("row_smoke_mobile_RTL_both_themes_and_keyboard_keep_selected_fields_and_focus_accessible", async ({
  page,
  request,
}) => {
  let identityReads = 0;
  let sessionReads = 0;
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (
      url.pathname === "/api/v1/query" &&
      url.searchParams.get("operation") === "whoami"
    )
      identityReads++;
    if (url.pathname === "/api/auth/get-session") sessionReads++;
  });
  const prefix = `SYNTHETIC ROW MOBILE ${crypto.randomUUID().slice(0, 8)}`;
  const a = await createTask(
    request,
    `${prefix} فارسی و English متن بلند برای ردیف`,
    { notes: "" },
  );
  await page.setViewportSize({ width: 390, height: 844 });
  for (const theme of ["light", "dark"]) {
    const preferences = await read<Preferences>(request, "preferences_get");
    await write(
      request,
      "preferences_update",
      { settings: { language: "fa", theme } },
      preferences.revision,
    );
    await page.goto(
      `/tasks?${new URLSearchParams({ search: prefix, view: "list" })}`,
    );
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await expect(row(page, a.task_id)).toBeVisible();
    const verifiedIdentityReads = identityReads;
    const verifiedSessionReads = sessionReads;
    expect(verifiedIdentityReads).toBeGreaterThan(0);
    expect(verifiedSessionReads).toBeGreaterThan(0);
    const priority = field(page, a.task_id, "priority").getByRole("button", {
      name: "ویرایش اولویت",
      exact: true,
    });
    await expect(priority).toBeVisible();
    await expect(field(page, a.task_id, "due_date")).toBeVisible();
    await priority.focus();
    await priority.press("Enter");
    let editor = field(page, a.task_id, "priority").getByTestId(
      "task-field-editor",
    );
    await expect(editor.locator('select[name="priority"]')).toBeFocused();
    await editor
      .locator('select[name="priority"]')
      .selectOption(theme === "light" ? "High" : "Urgent");
    await expect
      .poll(async () => (await task(request, a.task_id)).priority)
      .toBe(theme === "light" ? "High" : "Urgent");
    await expect(priority).toBeFocused();
    const due = field(page, a.task_id, "due_date").getByRole("button", {
      name: "ویرایش موعد روزانه",
      exact: true,
    });
    await due.focus();
    await due.press("Space");
    editor = field(page, a.task_id, "due_date").getByTestId(
      "task-field-editor",
    );
    await editor
      .locator('input[name="due_date"]')
      .fill(theme === "light" ? "2037-04-10" : "2037-04-11");
    const save = editor.getByRole("button", { name: "ثبت", exact: true });
    // Native date inputs may expose several keyboard segments before their
    // following button. Exercise real Tab navigation without assuming one step.
    for (let step = 0; step < 6; step++) {
      await page.keyboard.press("Tab");
      if (await save.evaluate((button) => button === document.activeElement))
        break;
    }
    await expect(save).toBeFocused();
    await save.press("Enter");
    await expect
      .poll(async () => (await task(request, a.task_id)).due_date)
      .toBe(theme === "light" ? "2037-04-10" : "2037-04-11");
    await expect(due).toBeFocused();
    await page.evaluate(() => {
      window.dispatchEvent(new Event("lifeos:changed"));
      window.dispatchEvent(new Event("focus"));
    });
    const notes = await openEditor(page, a.task_id, "notes");
    await notes.locator("textarea").fill(`Keyboard draft ${theme}`);
    await notes.locator("textarea").press("Escape");
    await expect(notes).toHaveCount(0);
    await expect(
      field(page, a.task_id, "notes").getByRole("button", {
        name: "ویرایش توضیحات",
        exact: true,
      }),
    ).toBeFocused();
    expect((await task(request, a.task_id)).notes).toBe("");
    const retained = await openEditor(page, a.task_id, "notes");
    await expect(retained.locator("textarea")).toHaveValue("");
    await retained.locator("textarea").fill(`Explicit retained draft ${theme}`);
    await retained
      .getByRole("button", { name: "بستن و نگه‌داشتن پیش‌نویس", exact: true })
      .click();
    if (theme === "light") {
      // A deliberate accepted app-navigation confirmation is distinct from
      // discarding the field. Browser Back must recover the workspace draft.
      page.once("dialog", (dialog) => dialog.accept());
      await page
        .getByRole("navigation", { name: "پیمایش موبایل", exact: true })
        .getByRole("link", { name: "امروز", exact: true })
        .click();
      await expect(page).toHaveURL(origin + "/");
      await page.goBack();
      await expect(row(page, a.task_id)).toBeVisible();
    }
    const reopened = await openEditor(page, a.task_id, "notes");
    await expect(reopened.locator("textarea")).toHaveValue(
      `Explicit retained draft ${theme}`,
    );
    await reopened.getByRole("button", { name: "لغو", exact: true }).click();
    // Saves, foreground refresh and soft app history keep the already verified
    // session/owner scope; they must not consume a new identity/auth read each.
    expect(identityReads).toBe(verifiedIdentityReads);
    expect(sessionReads).toBe(verifiedSessionReads);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    ).toBe(true);
    if (screenshotDirectory)
      await page.screenshot({
        path: join(
          screenshotDirectory,
          `synthetic-task-row-mobile-${theme}.png`,
        ),
        fullPage: true,
      });
  }
});
