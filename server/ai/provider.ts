import { getAuthPool } from "@/server/auth/db";
import { DomainError, type Principal } from "@/shared/contracts";
import { instantToLocalDate } from "@/shared/datetime";
import {
  estimateAiReservation,
  type AiConfiguration,
} from "@/server/integrations/ai-guard";

export async function requestModel(
  messages: unknown,
  configuration: AiConfiguration,
  principal: Principal,
  previousReservationMicros: number,
) {
  const estimate = estimateAiReservation(messages, configuration);
  if (
    previousReservationMicros + estimate.reservationMicros >
    configuration.dailyBudgetMicros
  )
    throw new DomainError(
      "INSUFFICIENT_PERMISSIONS",
      "مجموع سقف هزینهٔ این درخواست از بودجه بیشتر است.",
      {},
      429,
    );
  const budget = await getAuthPool().query(
    `INSERT INTO ai_usage(owner_id,usage_date,cost_microusd) VALUES($1,$2::date,$3)
    ON CONFLICT(owner_id,usage_date) DO UPDATE SET cost_microusd=ai_usage.cost_microusd+$3 WHERE ai_usage.cost_microusd+$3 <= $4 RETURNING cost_microusd`,
    [
      principal.ownerId,
      instantToLocalDate(new Date()),
      estimate.reservationMicros,
      configuration.dailyBudgetMicros,
    ],
  );
  if (!budget.rowCount)
    throw new DomainError(
      "INSUFFICIENT_PERMISSIONS",
      "بودجهٔ روزانهٔ مدل مصرف شده است.",
      {},
      429,
    );
  const { provider, key, model } = configuration;
  const response = await fetch(
    new URL(
      "chat/completions",
      provider.href.endsWith("/") ? provider : new URL(provider.href + "/"),
    ),
    {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(45000),
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        n: 1,
        ...(provider.hostname === "api.openai.com"
          ? { max_completion_tokens: configuration.maxOutputTokens }
          : { max_tokens: configuration.maxOutputTokens }),
        response_format: { type: "json_object" },
        messages,
      }),
    },
  );
  if (!response.ok)
    throw new DomainError(
      "UNSUPPORTED_OPERATION",
      "مدل پاسخ نداد؛ اتصال، اعتبار یا محدودیت سرویس را بررسی کنید.",
      { provider_status: response.status },
      502,
    );
  let result: {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { total_tokens?: number };
  };
  try {
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Missing provider body");
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > 128000) {
          await reader.cancel();
          throw new Error("Provider response exceeds bound");
        }
        chunks.push(part.value);
      }
    } finally {
      reader.releaseLock();
    }
    result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new DomainError(
      "INVALID_INPUT",
      "پاسخ سرویس مدل معتبر یا در محدودهٔ مجاز نیست.",
      {},
      502,
    );
  }
  const content = result.choices?.[0]?.message?.content;
  if (typeof content !== "string" || content.length > 24000)
    throw new DomainError("INVALID_INPUT", "پاسخ مدل معتبر نیست.", {}, 502);
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new DomainError("INVALID_INPUT", "طرح مدل JSON معتبر نیست.", {}, 502);
  }
  return {
    parsed,
    ...estimate,
    tokens:
      Number.isSafeInteger(result.usage?.total_tokens) &&
      Number(result.usage?.total_tokens) >= 0
        ? Number(result.usage?.total_tokens)
        : null,
  };
}
