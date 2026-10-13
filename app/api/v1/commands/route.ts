import { COMMAND_NAMES } from "@/shared/contracts";
import { getDomainService } from "@/server/domain/service";
import { requirePrincipal } from "@/server/auth/principal";
import {
  failure,
  success,
  readJson,
  recordInput,
  rateLimit,
} from "@/server/http";
import { z } from "zod";
export const runtime = "nodejs";
export async function POST(request: Request) {
  try {
    const principal = await requirePrincipal(request);
    await rateLimit(principal.actorId, "write", 120);
    const { command, input } = z
      .object({ command: z.enum(COMMAND_NAMES), input: recordInput })
      .strict()
      .parse(await readJson(request));
    const idempotencyKey = z
      .string()
      .min(8)
      .max(200)
      .parse(request.headers.get("idempotency-key"));
    const header = request.headers.get("if-match");
    const expectedRevision = header
      ? z.coerce.number().int().nonnegative().parse(header.replaceAll('"', ""))
      : undefined;
    return success(
      await getDomainService().execute(command, input, principal, {
        idempotencyKey,
        expectedRevision,
      }),
    );
  } catch (error) {
    return failure(error);
  }
}
