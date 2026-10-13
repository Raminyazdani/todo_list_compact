import { QUERY_NAMES } from "@/shared/contracts";
import { getDomainService } from "@/server/domain/service";
import { requirePrincipal } from "@/server/auth/principal";
import { failure, success, recordInput, rateLimit } from "@/server/http";
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
