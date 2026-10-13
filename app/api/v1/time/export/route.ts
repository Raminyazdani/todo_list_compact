import { requirePrincipal } from "@/server/auth/principal";
import { getDomainService } from "@/server/domain/service";
import { exportEmployerXlsx, type WorkEntry } from "@/server/integrations/time";
import { failure, rateLimit } from "@/server/http";
import { z } from "zod";
export async function GET(request: Request) {
  try {
    const principal = await requirePrincipal(request);
    await rateLimit(principal.actorId, "export", 10);
    const url = new URL(request.url);
    const month = z
      .string()
      .regex(/^\d{4}-(0[1-9]|1[0-2])$/)
      .parse(url.searchParams.get("month"));
    const employer = z
      .enum(["Jena", "Seewiesen"])
      .parse(url.searchParams.get("employer"));
    const entries: WorkEntry[] = [];
    let cursor: string | null = null;
    do {
      const page = (await getDomainService().query(
        "time_entry_list",
        { employer, limit: 200, ...(cursor ? { cursor } : {}) },
        principal,
      )) as { items: WorkEntry[]; next_cursor: string | null };
      entries.push(...page.items);
      cursor = page.next_cursor;
      if (entries.length > 50000) throw new Error("Export limit exceeded");
    } while (cursor);
    const bytes = await exportEmployerXlsx(entries, month, employer);
    return new Response(new Uint8Array(bytes), {
      headers: {
        "Content-Type":
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${employer}-${month}.xlsx"`,
        "Cache-Control": "private, no-store",
      },
    });
  } catch (error) {
    return failure(error);
  }
}
