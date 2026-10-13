import { openApiDocument } from "@/server/openapi";
export async function GET() {
  return Response.json(openApiDocument());
}
