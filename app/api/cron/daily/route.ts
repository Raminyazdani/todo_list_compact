import { createHash, timingSafeEqual } from "node:crypto";
import { runDaily } from "@/server/jobs/daily";
import { runEncryptedBackup } from "@/server/jobs/backup";
import { success, failure } from "@/server/http";
export const maxDuration = 60;
export async function GET(request: Request) {
  const expected = process.env.CRON_SECRET;
  const provided = request.headers.get("authorization") ?? "";
  if (
    !expected ||
    !process.env.OWNER_ID ||
    !timingSafeEqual(
      createHash("sha256").update(provided).digest(),
      createHash("sha256").update(`Bearer ${expected}`).digest(),
    )
  )
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const daily = await runDaily(process.env.OWNER_ID);
    const backup = await runEncryptedBackup(process.env.OWNER_ID);
    return success({ daily, backup });
  } catch (error) {
    return failure(error);
  }
}
