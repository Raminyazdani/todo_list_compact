import { z } from "zod";
import { DomainError } from "@/shared/contracts";
import { requirePrincipal } from "@/server/auth/principal";
import { getDomainService } from "@/server/domain/service";
import {
  MAX_UPLOAD_BYTES,
  uploadPrivateFile,
} from "@/server/integrations/storage";
import { success, failure, rateLimit } from "@/server/http";
export async function POST(request: Request) {
  try {
    const principal = await requirePrincipal(request);
    await rateLimit(principal.actorId, "upload", 10);
    const operation = z
      .string()
      .min(8)
      .max(200)
      .parse(request.headers.get("idempotency-key"));
    const chunks: Uint8Array[] = [];
    let length = 0;
    const reader = request.body?.getReader();
    if (!reader) throw new DomainError("INVALID_INPUT", "File body required");
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.length;
      if (length > MAX_UPLOAD_BYTES + 65536) {
        await reader.cancel();
        throw new DomainError("INVALID_INPUT", "Upload too large", {}, 413);
      }
      chunks.push(part.value);
    }
    const limited = new Request(request.url, {
      method: "POST",
      headers: request.headers,
      body: Buffer.concat(chunks),
    });
    const form = await limited.formData();
    const file = form.get("file");
    if (!(file instanceof File))
      throw new DomainError("INVALID_INPUT", "File required");
    const upload = await uploadPrivateFile(
      new Uint8Array(await file.arrayBuffer()),
      file.name,
      file.type || "application/octet-stream",
      principal,
      operation,
    );
    const fileId = form.get("file_id");
    const revision = request.headers.get("if-match");
    return success(
      await getDomainService().execute(
        "file_register_upload",
        {
          ...upload,
          ...(typeof fileId === "string" && fileId ? { file_id: fileId } : {}),
          title: file.name,
        },
        principal,
        {
          idempotencyKey: operation,
          expectedRevision: revision
            ? Number(revision.replaceAll('"', ""))
            : undefined,
        },
      ),
    );
  } catch (error) {
    return failure(error);
  }
}
