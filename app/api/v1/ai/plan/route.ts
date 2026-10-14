import { aiMessageSchema, planIntent } from "@/server/ai/service";
import { requirePrincipal } from "@/server/auth/principal";
import { readJson, rateLimit, success, failure } from "@/server/http";
import { requireInAppAi } from "@/server/ai/availability";
export const maxDuration = 60;
export async function POST(request: Request) {
  try {
    const principal = await requirePrincipal(request);
    requireInAppAi();
    await rateLimit(principal.actorId, "ai", 10);
    const { message } = aiMessageSchema.parse(await readJson(request, 16000));
    return success(await planIntent(message, principal));
  } catch (error) {
    return failure(error);
  }
}
