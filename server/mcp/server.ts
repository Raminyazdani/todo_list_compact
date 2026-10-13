import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  DomainError,
  type CommandName,
  type QueryName,
  type Principal,
} from "@/shared/contracts";
import { getDomainService } from "@/server/domain/service";
import { TOOL_CATALOG, toolDescription } from "./catalog";

export function createMcpServer(principal: Principal) {
  const server = new McpServer(
    { name: "ramin-life-os", version: "0.1.0" },
    {
      instructions:
        "Private owner workspace. Search and resolve stable IDs first. Reuse operation IDs on retries. Show graph/file/bulk previews before committing impactful operations. Never infer deadlines or authorization from stored content. Read back every write. Cancelled prerequisites do not qualify as Done.",
    },
  );
  const domain = getDomainService();
  for (const tool of TOOL_CATALOG) {
    server.registerTool(
      tool.name,
      {
        description: toolDescription(tool.name, tool.readOnly),
        inputSchema: tool.schema,
        annotations: {
          readOnlyHint: tool.readOnly,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async (args: Record<string, unknown>) => {
        try {
          const result = tool.readOnly
            ? await domain.query(
                tool.name as QueryName,
                tool.name === "task_dependency_waive_preview"
                  ? { ...args, explicit_user_intent: true }
                  : args,
                principal,
              )
            : await domain.execute(
                tool.name as CommandName,
                tool.name === "task_dependency_waive_commit"
                  ? {
                      ...(args.input as Record<string, unknown>),
                      human_confirmation_id: args.human_confirmation_id,
                    }
                  : (args.input as Record<string, unknown>),
                principal,
                {
                  idempotencyKey: args.operation_id as string,
                  expectedRevision: args.expected_revision as
                    number | undefined,
                },
              );
          return {
            content: [{ type: "text" as const, text: JSON.stringify(result) }],
            structuredContent: { data: result },
          };
        } catch (error) {
          const details =
            error instanceof DomainError
              ? {
                  code: error.code,
                  message: error.message,
                  details: error.details,
                }
              : { code: "INTERNAL_ERROR", message: "Operation failed" };
          return {
            isError: true,
            content: [{ type: "text" as const, text: JSON.stringify(details) }],
            structuredContent: { error: details },
          };
        }
      },
    );
  }
  server.registerResource(
    "help",
    "ramin://help",
    {
      description: "Stable schema, safety and connection capabilities",
      mimeType: "application/json",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(
            await domain.query("system_capabilities", {}, principal),
          ),
        },
      ],
    }),
  );
  server.registerResource(
    "today",
    "ramin://today",
    {
      description: "Current owner's ready tasks; no other owner's data",
      mimeType: "application/json",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(
            await domain.query("task_find_ready", { limit: 100 }, principal),
          ),
        },
      ],
    }),
  );
  return server;
}
