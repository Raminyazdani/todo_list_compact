import {
  DomainError,
  type DomainService,
  type Principal,
} from "../../shared/contracts";
export interface AiConfiguration {
  provider: URL;
  key: string;
  model: string;
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
  pricingVerifiedAt: string;
  maxContextBytes: number;
  maxOutputTokens: number;
  dailyBudgetMicros: number;
}
const approvedHosts = new Set([
  "ai-gateway.vercel.sh",
  "api.openai.com",
  "openrouter.ai",
]);
function numberSetting(name: string, fallback?: number): number {
  const value = process.env[name]?.trim();
  if (!value && fallback === undefined)
    throw new DomainError(
      "UNSUPPORTED_OPERATION",
      "AI_PRICING_NOT_VERIFIED: سقف قیمت مدل باید تأیید و تنظیم شود.",
      { configured: false },
      503,
    );
  const number = value ? Number(value) : fallback!;
  if (!Number.isFinite(number) || number < 0)
    throw new DomainError("INVALID_INPUT", "Invalid AI numeric configuration.");
  return number;
}
export function resolveAiConfiguration(): AiConfiguration {
  const model = process.env.AI_MODEL,
    rawProvider = process.env.AI_PROVIDER_URL;
  const key =
    process.env.AI_PROVIDER_KEY ||
    process.env.AI_GATEWAY_API_KEY ||
    process.env.VERCEL_OIDC_TOKEN;
  if (!model || !rawProvider || !key)
    throw new DomainError(
      "UNSUPPORTED_OPERATION",
      "AI_NOT_CONFIGURED: اتصال مدل هنوز پیکربندی نشده است.",
      { configured: false },
      503,
    );
  let provider: URL;
  try {
    provider = new URL(rawProvider);
  } catch {
    throw new DomainError("INVALID_INPUT", "Invalid AI provider URL.");
  }
  if (
    provider.protocol !== "https:" ||
    !approvedHosts.has(provider.hostname) ||
    provider.username ||
    provider.password ||
    provider.search ||
    provider.hash ||
    (provider.port && provider.port !== "443")
  )
    throw new DomainError(
      "INVALID_INPUT",
      "AI provider must use an approved HTTPS host without user information or redirects.",
    );
  if (model.length > 200 || process.env.AI_PRICING_MODEL !== model)
    throw new DomainError(
      "UNSUPPORTED_OPERATION",
      "AI_PRICING_NOT_VERIFIED: قیمت تأییدشده باید متعلق به همین مدل باشد.",
      { configured: false },
      503,
    );
  const verifiedAt = process.env.AI_PRICING_VERIFIED_AT || "",
    age = Date.now() - Date.parse(verifiedAt);
  if (!Number.isFinite(age) || age < -60000 || age > 7 * 86400000)
    throw new DomainError(
      "UNSUPPORTED_OPERATION",
      "AI_PRICING_STALE: سقف قیمت مدل باید در هفت روز اخیر بررسی شده باشد.",
      { configured: false },
      503,
    );
  const inputUsdPerMillion = numberSetting("AI_INPUT_USD_PER_MILLION_TOKENS"),
    outputUsdPerMillion = numberSetting("AI_OUTPUT_USD_PER_MILLION_TOKENS");
  const maxContextBytes = numberSetting("AI_MAX_CONTEXT_BYTES", 24000),
    maxOutputTokens = numberSetting("AI_MAX_OUTPUT_TOKENS", 1200),
    budget = numberSetting("AI_DAILY_BUDGET_USD", 1);
  if (
    !Number.isInteger(maxContextBytes) ||
    maxContextBytes < 4000 ||
    maxContextBytes > 64000 ||
    !Number.isInteger(maxOutputTokens) ||
    maxOutputTokens < 128 ||
    maxOutputTokens > 2000 ||
    budget <= 0 ||
    budget > 100 ||
    inputUsdPerMillion > 10000 ||
    outputUsdPerMillion > 10000
  )
    throw new DomainError(
      "INVALID_INPUT",
      "AI limits exceed the supported configuration bounds.",
    );
  return {
    provider,
    key,
    model,
    inputUsdPerMillion,
    outputUsdPerMillion,
    pricingVerifiedAt: verifiedAt,
    maxContextBytes,
    maxOutputTokens,
    dailyBudgetMicros: Math.floor(budget * 1e6),
  };
}
type RecordValue = Record<string, unknown>;
function rows(result: unknown): RecordValue[] {
  if (
    !result ||
    typeof result !== "object" ||
    !("items" in result) ||
    !Array.isArray(result.items)
  )
    return [];
  return result.items
    .filter((row): row is RecordValue => !!row && typeof row === "object")
    .slice(0, 100);
}
function clipped(value: unknown, length: number) {
  return typeof value === "string"
    ? Array.from(value).slice(0, length).join("")
    : value === null || typeof value === "boolean" || typeof value === "number"
      ? value
      : undefined;
}
function pick(
  row: RecordValue,
  fields: readonly string[],
  onClip?: () => void,
): RecordValue {
  return Object.fromEntries(
    fields
      .filter((field) => row[field] !== undefined)
      .map((field) => {
        const length = field.endsWith("_id")
          ? 512
          : field === "notes" ||
              field === "next_action" ||
              field === "waiting_for"
            ? 400
            : 200;
        if (
          typeof row[field] === "string" &&
          Array.from(row[field] as string).length > length
        )
          onClip?.();
        return [field, clipped(row[field], length)];
      }),
  );
}
const taskFields = [
  "task_id",
  "title",
  "status",
  "priority",
  "category",
  "notes",
  "next_action",
  "waiting_for",
  "project_id",
  "parent_task_id",
  "due_date",
  "due_at",
  "start_date",
  "revision",
  "readiness",
];
function relevantScore(task: RecordValue, message: string) {
  const text = String(task.title || "").toLowerCase(),
    body = String(task.notes || "").toLowerCase();
  let score = message.includes(String(task.task_id)) ? 10000 : 0;
  for (const term of message
    .toLowerCase()
    .split(/[\s،,.!?;:]+/)
    .filter(
      (term) =>
        term.length > 2 &&
        ![
          "task",
          "this",
          "show",
          "تسک",
          "کارها",
          "همه",
          "برای",
          "بده",
          "نشان",
        ].includes(term),
    )
    .slice(0, 30))
    score += text.includes(term) ? 5 : body.includes(term) ? 1 : 0;
  return score;
}
export async function boundedAiContext(
  domain: DomainService,
  message: string,
  principal: Principal,
  maxBytes: number,
) {
  const aiPrincipal = { ...principal, channel: "AI" as const },
    admin = principal.scopes.includes("admin:manage");
  const [taskResult, projectResult, fileResult, templateResult] =
    await Promise.all([
      domain.query("task_search", { limit: 100 }, aiPrincipal),
      admin || principal.scopes.includes("projects:read")
        ? domain.query("project_list", { limit: 40 }, aiPrincipal)
        : Promise.resolve({ items: [] }),
      admin || principal.scopes.includes("files:read")
        ? domain.query("file_search", { limit: 40 }, aiPrincipal)
        : Promise.resolve({ items: [] }),
      domain.query("task_template_list", { limit: 20 }, aiPrincipal),
    ]);
  const selected = rows(taskResult)
    .sort((a, b) => relevantScore(b, message) - relevantScore(a, message))
    .slice(0, 40);
  const details = await Promise.all(
    selected
      .slice(0, 6)
      .map((task) =>
        domain.query("task_get", { task_id: task.task_id }, aiPrincipal),
      ),
  );
  let truncated =
    selected.length < rows(taskResult).length ||
    details.length < selected.length ||
    rows(projectResult).length > 20 ||
    rows(fileResult).length > 20;
  const boundedPick = (row: RecordValue, fields: readonly string[]) =>
    pick(row, fields, () => {
      truncated = true;
    });
  const context: Record<string, RecordValue[]> = {
    tasks: selected.map((task) => boundedPick(task, taskFields)),
    projects: rows(projectResult)
      .slice(0, 20)
      .map((project) =>
        boundedPick(project, ["project_id", "title", "revision", "status"]),
      ),
    files: rows(fileResult)
      .slice(0, 20)
      .map((file) =>
        boundedPick(file, [
          "file_id",
          "title",
          "original_filename",
          "state",
          "revision",
        ]),
      ),
    templates: rows(templateResult)
      .slice(0, 20)
      .map((template) => ({
        ...boundedPick(template, ["template_id", "title", "revision"]),
        task_count:
          template.definition &&
          typeof template.definition === "object" &&
          "tasks" in template.definition &&
          Array.isArray(template.definition.tasks)
            ? template.definition.tasks.length
            : null,
      })),
    task_details: details
      .filter(
        (detail): detail is RecordValue =>
          !!detail && typeof detail === "object",
      )
      .map((detail) => ({
        ...boundedPick(detail, taskFields),
        checklists: Array.isArray(detail.checklists)
          ? detail.checklists.slice(0, 4).map((list: RecordValue) => ({
              ...boundedPick(list, ["checklist_id", "title", "revision"]),
              items: Array.isArray(list.items)
                ? list.items
                    .slice(0, 12)
                    .map((item: RecordValue) =>
                      boundedPick(item, [
                        "item_id",
                        "title",
                        "notes",
                        "checked",
                        "revision",
                        "promoted_task_id",
                      ]),
                    )
                : [],
            }))
          : [],
        prerequisites: Array.isArray(detail.prerequisites)
          ? detail.prerequisites
              .slice(0, 12)
              .map((edge: RecordValue) =>
                boundedPick(edge, [
                  "edge_id",
                  "group_id",
                  "prerequisite_task_id",
                  "operator",
                  "mode",
                  "status",
                ]),
              )
          : [],
        subtasks: Array.isArray(detail.subtasks)
          ? detail.subtasks
              .slice(0, 12)
              .map((task: RecordValue) => boundedPick(task, taskFields))
          : [],
      })),
  };
  while (Buffer.byteLength(JSON.stringify(context), "utf8") > maxBytes) {
    const largest = Object.keys(context)
      .filter((key) => context[key].length)
      .sort(
        (a, b) =>
          Buffer.byteLength(JSON.stringify(context[b])) -
          Buffer.byteLength(JSON.stringify(context[a])),
      )[0];
    if (!largest)
      throw new DomainError(
        "INVALID_INPUT",
        "AI context cannot fit the configured bounds.",
      );
    context[largest].pop();
    truncated = true;
  }
  return {
    context,
    bytes: Buffer.byteLength(JSON.stringify(context), "utf8"),
    truncated,
    warnings: [
      "متن زمینه محدود شده است؛ شناسهٔ ناموجود یا مورد مبهم باید قبل از تغییر روشن شود.",
    ],
  };
}
/** One token cannot consume less than a UTF-8 byte; overhead has a separate allowance. */
export function estimateAiReservation(
  messages: unknown,
  configuration: AiConfiguration,
) {
  const inputTokenUpperBound =
    Buffer.byteLength(JSON.stringify(messages), "utf8") + 4096;
  const reservationMicros = Math.max(
    1,
    Math.ceil(
      inputTokenUpperBound * configuration.inputUsdPerMillion +
        configuration.maxOutputTokens * configuration.outputUsdPerMillion,
    ),
  );
  if (
    !Number.isSafeInteger(reservationMicros) ||
    reservationMicros > configuration.dailyBudgetMicros
  )
    throw new DomainError(
      "INSUFFICIENT_PERMISSIONS",
      "بودجهٔ روزانه از سقف هزینهٔ این درخواست کمتر است.",
      { reservation_usd: reservationMicros / 1e6 },
      429,
    );
  return { inputTokenUpperBound, reservationMicros };
}
