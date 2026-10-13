import { getAuth } from "@/server/auth/config";
import { failure } from "@/server/http";
import { DomainError } from "@/shared/contracts";
export const runtime = "nodejs";
export async function GET(request: Request) {
  try {
    return await getAuth().handler(request);
  } catch {
    return failure(
      new DomainError(
        "DATABASE_UNAVAILABLE",
        "Authentication is temporarily unavailable",
        {},
        503,
      ),
    );
  }
}
export async function POST(request: Request) {
  return GET(request);
}
