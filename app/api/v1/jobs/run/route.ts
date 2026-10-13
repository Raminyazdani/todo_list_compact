import { requirePrincipal } from "@/server/auth/principal";
import { runDaily } from "@/server/jobs/daily";
import { rateLimit, success, failure } from "@/server/http";
import { DomainError } from "@/shared/contracts";
export async function POST(request: Request) {
  try {
    const principal = await requirePrincipal(request);
    if (!principal.scopes.includes("admin:manage"))
      throw new DomainError(
        "INSUFFICIENT_PERMISSIONS",
        "Owner administration required",
        {},
        403,
      );
    await rateLimit(principal.actorId, "jobs", 5);
    return success(await runDaily(principal.ownerId, principal.actorId, true));
  } catch (error) {
    return failure(error);
  }
}
