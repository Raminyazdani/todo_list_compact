import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createMcpServer } from "@/server/mcp/server";
import { requirePrincipal } from "@/server/auth/principal";
import { appOrigin } from "@/server/auth/config";
import { failure, rateLimit } from "@/server/http";
export const runtime = "nodejs";
export const maxDuration = 60;
export async function POST(request: Request) {
  try {
    // Remote MCP accepts scoped OAuth tokens only; browser cookies cannot grant MCP client rights.
    if (!request.headers.has("authorization"))
      return Response.json(
        { error: "Authentication required" },
        {
          status: 401,
          headers: {
            "WWW-Authenticate": `Bearer resource_metadata="${appOrigin()}/.well-known/oauth-protected-resource/api/mcp"`,
          },
        },
      );
    const principal = await requirePrincipal(request, "MCP");
    await rateLimit(principal.actorId, "mcp", 120);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
      maxRequestBodySize: 1024 * 1024,
    });
    const server = createMcpServer(principal);
    await server.connect(transport);
    return await transport.handleRequest(request);
  } catch (error) {
    return failure(error, true);
  }
}
export async function GET(request: Request) {
  if (!request.headers.has("authorization"))
    return Response.json(
      { error: "Authentication required" },
      {
        status: 401,
        headers: {
          "WWW-Authenticate": `Bearer resource_metadata="${appOrigin()}/.well-known/oauth-protected-resource/api/mcp"`,
        },
      },
    );
  try {
    await requirePrincipal(request, "MCP");
    return new Response(null, { status: 405, headers: { Allow: "POST" } });
  } catch (error) {
    return failure(error, true);
  }
}
export const DELETE = GET;
