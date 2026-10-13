import { randomUUID } from "node:crypto";
import { getDomainService } from "@/server/domain/service";
import type { Principal } from "@/shared/contracts";
export async function runDaily(
  ownerId: string,
  actorId = "approved-daily-scheduler",
  manual = false,
) {
  const principal: Principal = {
    ownerId,
    actorId,
    channel: "system",
    scopes: ["admin:manage"],
  };
  const day = new Date().toISOString().slice(0, 10);
  return getDomainService().execute("system_daily_run", {}, principal, {
    idempotencyKey: manual
      ? `manual-daily:${randomUUID()}`
      : `daily:${day}:${ownerId}`,
  });
}
