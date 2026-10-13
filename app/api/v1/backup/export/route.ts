import { requirePrincipal } from "@/server/auth/principal";
import { getDomainService } from "@/server/domain/service";
import { failure, rateLimit } from "@/server/http";
export async function GET(request: Request) {
  try {
    const principal = await requirePrincipal(request);
    await rateLimit(principal.actorId, "backup", 5);
    const backup = await getDomainService().query(
      "backup_export",
      {},
      principal,
    );
    return new Response(JSON.stringify(backup), {
      headers: {
        "Content-Type": "application/json",
        "Content-Disposition":
          'attachment; filename="ramin-life-os-backup.json"',
        "Cache-Control": "private, no-store",
      },
    });
  } catch (error) {
    return failure(error);
  }
}
