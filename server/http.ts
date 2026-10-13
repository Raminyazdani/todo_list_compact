import { randomUUID } from "node:crypto";
import { z } from "zod";
import { DomainError } from "@/shared/contracts";
import { getAuthPool } from "@/server/auth/db";
import { appOrigin } from "@/server/auth/config";

export const recordInput = z.record(z.string(), z.unknown());
export async function readJson(
  request: Request,
  maxBytes = 1024 * 1024,
): Promise<unknown> {
  const chunks: Uint8Array[] = [];
  let length = 0;
  if (request.body) {
    const reader = request.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > maxBytes) {
        await reader.cancel();
        throw new DomainError("INVALID_INPUT", "Request too large", {}, 413);
      }
      chunks.push(value);
    }
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new DomainError("INVALID_INPUT", "Invalid JSON");
  }
}
export async function rateLimit(
  principalId: string,
  group = "api",
  limit = 120,
) {
  const key = `${group}:${principalId}`;
  const result = await getAuthPool().query(
    `INSERT INTO runtime_rate_limits (key, bucket, count) VALUES ($1,date_trunc('minute',now()),1)
    ON CONFLICT (key) DO UPDATE SET bucket=EXCLUDED.bucket,count=CASE WHEN runtime_rate_limits.bucket=EXCLUDED.bucket THEN runtime_rate_limits.count+1 ELSE 1 END RETURNING count`,
    [key],
  );
  if (result.rows[0].count > limit)
    throw new DomainError(
      "INSUFFICIENT_PERMISSIONS",
      "Rate limit exceeded",
      {},
      429,
    );
}
export function success(data: unknown, status = 200) {
  return Response.json(
    { data, request_id: randomUUID() },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}
export function failure(error: unknown, mcp = false) {
  const domain = error instanceof DomainError ? error : null;
  const code =
    domain?.code ??
    (error instanceof z.ZodError ? "INVALID_INPUT" : "INTERNAL_ERROR");
  const status = domain?.status ?? (error instanceof z.ZodError ? 400 : 500);
  const headers: Record<string, string> = { "Cache-Control": "no-store" };
  if (mcp && status === 401)
    headers["WWW-Authenticate"] =
      `Bearer resource_metadata="${appOrigin()}/.well-known/oauth-protected-resource/api/mcp"`;
  return Response.json(
    {
      error: {
        code,
        message:
          domain?.message ??
          (status === 400 ? "Invalid input" : "Request failed"),
        details: domain?.details ?? {},
      },
      request_id: randomUUID(),
    },
    { status, headers },
  );
}
