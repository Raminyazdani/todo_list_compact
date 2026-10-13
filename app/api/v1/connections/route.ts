import { z } from "zod";
import { requirePrincipal } from "@/server/auth/principal";
import {
  listOwnerConnections,
  revokeOwnerConnection,
} from "@/server/auth/connections";
import { failure, success, rateLimit, readJson } from "@/server/http";
export async function GET(request: Request) {
  try {
    const principal = await requirePrincipal(request);
    await rateLimit(principal.actorId, "connections", 60);
    return success(await listOwnerConnections(principal));
  } catch (error) {
    return failure(error);
  }
}
export async function POST(request: Request) {
  try {
    const principal = await requirePrincipal(request);
    await rateLimit(principal.actorId, "connections-write", 10);
    const input = z
      .object({ client_id: z.string(), explicit_confirmation: z.literal(true) })
      .strict()
      .parse(await readJson(request));
    return success(await revokeOwnerConnection(input.client_id, principal));
  } catch (error) {
    return failure(error);
  }
}
