import { z } from "zod";
import { requirePrincipal } from "@/server/auth/principal";
import { DomainError } from "@/shared/contracts";
import { issueConfirmation } from "@/server/approvals";
import { readJson, failure, success } from "@/server/http";
export async function POST(request: Request) {
  try {
    if (request.headers.has("authorization"))
      throw new DomainError(
        "INSUFFICIENT_PERMISSIONS",
        "Use the owner's authenticated browser to approve",
        {},
        403,
      );
    const principal = await requirePrincipal(request);
    const body = z
      .object({
        command: z.literal("task_dependency_waive_commit"),
        input: z.object({ preview_id: z.string() }),
      })
      .strict()
      .parse(await readJson(request, 4000));
    return success(
      await issueConfirmation(body.command, body.input, principal),
    );
  } catch (error) {
    return failure(error);
  }
}
