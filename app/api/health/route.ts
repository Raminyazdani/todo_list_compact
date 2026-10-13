import { getAuthPool } from "@/server/auth/db";
export const runtime = "nodejs";
export async function GET() {
  try {
    await getAuthPool().query("SELECT 1");
    return Response.json(
      { status: "ok" },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return Response.json(
      { status: "unavailable" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
