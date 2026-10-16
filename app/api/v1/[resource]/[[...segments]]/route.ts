import { z } from "zod";
import {
  DomainError,
  type QueryName,
  type CommandName,
} from "@/shared/contracts";
import { requirePrincipal } from "@/server/auth/principal";
import { getDomainService } from "@/server/domain/service";
import {
  readJson,
  recordInput,
  rateLimit,
  success,
  failure,
} from "@/server/http";

const routes: Record<
  string,
  {
    list: QueryName;
    get?: QueryName;
    create?: CommandName;
    update?: CommandName;
    archive?: CommandName;
    id?: string;
  }
> = {
  tasks: {
    list: "task_search",
    get: "task_get",
    create: "task_create",
    update: "task_update",
    archive: "task_archive",
    id: "task_id",
  },
  projects: {
    list: "project_list",
    get: "project_get",
    create: "project_create",
    update: "project_update",
    id: "project_id",
  },
  files: {
    list: "file_search",
    get: "file_get_metadata",
    create: "file_register_external_link",
    id: "file_id",
  },
  events: {
    list: "calendar_events_query",
    create: "calendar_create_local_event",
    update: "calendar_update_local_event",
    archive: "calendar_delete_local_event",
    id: "event_id",
  },
  "time-entries": {
    list: "time_entry_list",
    create: "time_entry_create",
    update: "time_entry_update",
    archive: "time_entry_archive",
    id: "entry_id",
  },
  activity: { list: "get_activity" },
  search: { list: "search_all" },
  analytics: { list: "analytics_summary" },
  notifications: {
    list: "notifications_list",
    update: "notification_mark_read",
    id: "notification_id",
  },
  reminders: { list: "reminder_list", create: "reminder_create" },
  "saved-views": {
    list: "saved_view_list",
    create: "saved_view_create",
    update: "saved_view_update",
    id: "view_id",
  },
  "calendar-connections": {
    list: "calendar_list",
    create: "calendar_source_configure",
    update: "calendar_source_configure",
    archive: "calendar_source_disconnect",
    id: "source_id",
  },
  "calendar-operations": { list: "calendar_operation_status" },
  "time-drafts": {
    list: "time_draft_list",
    create: "time_draft_save",
    update: "time_draft_save",
    archive: "time_draft_archive",
    id: "draft_id",
  },
};
type Context = { params: Promise<{ resource: string; segments?: string[] }> };
async function handle(request: Request, context: Context) {
  try {
    const principal = await requirePrincipal(request);
    await rateLimit(
      principal.actorId,
      request.method === "GET" ? "read" : "write",
      request.method === "GET" ? 600 : 120,
    );
    const { resource, segments = [] } = await context.params;
    if (segments.length > 1)
      throw new DomainError("ENTITY_NOT_FOUND", "Endpoint not found", {}, 404);
    const route = routes[resource];
    if (!route)
      throw new DomainError("ENTITY_NOT_FOUND", "Endpoint not found", {}, 404);
    const domain = getDomainService();
    const identifier = segments[0];
    if (request.method === "GET") {
      const params = new URL(request.url).searchParams;
      const input: Record<string, unknown> = {};
      for (const key of [
        "query",
        "search",
        "project_id",
        "status",
        "priority",
        "category",
        "readiness",
        "state",
        "from",
        "to",
        "employer",
        "calendar_id",
        "cursor",
        "entity_id",
      ])
        if (params.has(key)) input[key] = params.get(key);
      if (params.has("source_ids"))
        input.source_ids = z
          .array(z.string().min(1).max(512))
          .max(100)
          .parse(params.getAll("source_ids"));
      if (params.has("limit"))
        input.limit = z.coerce
          .number()
          .int()
          .min(1)
          .max(200)
          .parse(params.get("limit"));
      if (identifier) {
        if (!route.get || !route.id)
          throw new DomainError(
            "UNSUPPORTED_OPERATION",
            "Read entity through the query endpoint",
            {},
            405,
          );
        input[route.id] = identifier;
      }
      return success(
        await domain.query(
          identifier ? route.get! : route.list,
          input,
          principal,
        ),
      );
    }
    const command =
      request.method === "POST"
        ? route.create
        : request.method === "PATCH"
          ? route.update
          : route.archive;
    if (!command || (request.method !== "POST" && !identifier))
      throw new DomainError(
        "UNSUPPORTED_OPERATION",
        "Method not supported",
        {},
        405,
      );
    const input =
      request.method === "DELETE"
        ? {}
        : recordInput.parse(await readJson(request));
    if (identifier && route.id) input[route.id] = identifier;
    const idempotencyKey = z
      .string()
      .min(8)
      .max(200)
      .parse(request.headers.get("idempotency-key"));
    const revision = request.headers.get("if-match");
    const expectedRevision = revision
      ? z.coerce
          .number()
          .int()
          .nonnegative()
          .parse(revision.replaceAll('"', ""))
      : undefined;
    return success(
      await domain.execute(command, input, principal, {
        idempotencyKey,
        expectedRevision,
      }),
      request.method === "POST" ? 201 : 200,
    );
  } catch (error) {
    return failure(error);
  }
}
export const GET = handle;
export const POST = handle;
export const PATCH = handle;
export const DELETE = handle;
