import { appOrigin, OWNER_SCOPES } from "@/server/auth/config";
export async function GET() {
  const origin = appOrigin();
  return Response.json(
    {
      resource: `${origin}/api/mcp`,
      authorization_servers: [`${origin}/api/auth`],
      scopes_supported: OWNER_SCOPES,
      bearer_methods_supported: ["header"],
      resource_name: "Ramin Life OS",
    },
    {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "public, max-age=300",
      },
    },
  );
}
