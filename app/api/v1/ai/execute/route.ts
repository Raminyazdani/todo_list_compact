import { executePlan } from "@/server/ai/service";
import { requirePrincipal } from "@/server/auth/principal";
import { readJson, rateLimit, success, failure } from "@/server/http";
import { z } from "zod";
export async function POST(request: Request) {
  try {
    const principal = await requirePrincipal(request);
    await rateLimit(principal.actorId, "ai", 10);
    const { plan_id } = z
      .object({ plan_id: z.string().uuid() })
      .strict()
      .parse(await readJson(request, 1000));
    return success(await executePlan(plan_id, principal));
  } catch (error) {
    return failure(error);
  }
}
