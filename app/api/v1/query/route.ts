import { QUERY_NAMES } from "@/shared/contracts";
import { getDomainService } from "@/server/domain/service";
import { requirePrincipal } from "@/server/auth/principal";
import {
  failure,
  success,
  recordInput,
  rateLimit,
  readJson,
} from "@/server/http";
import { z } from "zod";
export const runtime = "nodejs";
export async function GET(request: Request) {
  try {
    const principal = await requirePrincipal(request);
    await rateLimit(principal.actorId, "read", 600);
    const url = new URL(request.url);
    const operation = z
      .enum(QUERY_NAMES)
      .parse(url.searchParams.get("operation"));
    const raw = url.searchParams.get("input") ?? "{}";
    if (raw.length > 16000)
      return Response.json(
        { error: { code: "INVALID_INPUT", message: "Input too large" } },
        { status: 413 },
      );
    const input = recordInput.parse(JSON.parse(raw));
    return success(await getDomainService().query(operation, input, principal));
  } catch (error) {
    return failure(error);
  }
}

/** JSON previews are authenticated and origin-checked before their bounded body is read. */
export async function POST(request: Request) {
  try {
    const principal = await requirePrincipal(request);
    await rateLimit(principal.actorId, "write", 120);
    const body = z
      .object({
        operation: z.enum(QUERY_NAMES),
        input: recordInput.default({}),
      })
      .strict()
      .parse(await readJson(request, 2 * 1024 * 1024));
    return success(
      await getDomainService().query(body.operation, body.input, principal),
    );
  } catch (error) {
    return failure(error);
  }
}
