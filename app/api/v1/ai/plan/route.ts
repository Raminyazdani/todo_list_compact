import { aiMessageSchema, planIntent } from "@/server/ai/service";
import { requirePrincipal } from "@/server/auth/principal";
import { readJson, rateLimit, success, failure } from "@/server/http";
export const maxDuration = 60;
export async function POST(request: Request) {
  try {
    const principal = await requirePrincipal(request);
    await rateLimit(principal.actorId, "ai", 10);
    const { message } = aiMessageSchema.parse(await readJson(request, 16000));
    return success(await planIntent(message, principal));
  } catch (error) {
    return failure(error);
  }
}
