import { requirePrincipal } from "@/server/auth/principal";
import { getDomainService } from "@/server/domain/service";
import { getDatabase } from "@/server/db/database";
import {
  readPrivateFile,
  attachmentHeaders,
} from "@/server/integrations/storage";
import { DomainError } from "@/shared/contracts";
import { failure, rateLimit } from "@/server/http";
export async function GET(
  request: Request,
  context: { params: Promise<{ fileId: string }> },
) {
  try {
    const principal = await requirePrincipal(request);
    await rateLimit(principal.actorId, "download", 60);
    const { fileId } = await context.params;
    await getDomainService().query(
      "file_get_metadata",
      { file_id: fileId },
      principal,
    );
    const rows = await getDatabase().query<{
      provider: string;
      external_url: string;
      storage_key: string;
      original_filename: string;
      mime_type: string;
    }>(
      "SELECT provider,external_url,storage_key,original_filename,mime_type FROM files WHERE file_id=$1 AND owner_id=$2",
      [fileId, principal.ownerId],
    );
    const file = rows.rows[0];
    if (!file)
      throw new DomainError("ENTITY_NOT_FOUND", "File not found", {}, 404);
    if (file.provider === "google_drive") {
      const target = new URL(file.external_url);
      if (
        target.protocol !== "https:" ||
        !["drive.google.com", "docs.google.com"].includes(target.hostname) ||
        target.username ||
        target.password
      )
        throw new DomainError("INVALID_INPUT", "Invalid Drive reference");
      return new Response(null, {
        status: 302,
        headers: {
          Location: target.href,
          "Cache-Control": "private, no-store",
        },
      });
    }
    return new Response(await readPrivateFile(file.storage_key, principal), {
      headers: attachmentHeaders(file.original_filename, file.mime_type),
    });
  } catch (error) {
    return failure(error);
  }
}
