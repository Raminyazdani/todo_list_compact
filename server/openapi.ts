import { COMMAND_NAMES, QUERY_NAMES } from "@/shared/contracts";
import { appOrigin } from "@/server/auth/config";

export function openApiDocument() {
  const response = {
    description: "Owner-bound canonical result",
    content: {
      "application/json": {
        schema: {
          type: "object",
          required: ["data", "request_id"],
          properties: {
            data: {},
            request_id: { type: "string", format: "uuid" },
          },
        },
      },
    },
  };
  const errors = {
    "400": { description: "Invalid typed input" },
    "401": { description: "Unauthenticated" },
    "403": { description: "Insufficient scope or rejected origin" },
    "409": { description: "Revision or idempotency conflict" },
    "429": { description: "Rate limit exceeded" },
  };
  return {
    openapi: "3.1.0",
    info: {
      title: "Ramin Life OS",
      version: "0.1.0",
      description:
        "Every adapter uses one PostgreSQL domain service. Private records require owner authentication. Never invent deadlines or source relationships.",
    },
    servers: [{ url: appOrigin() }],
    security: [{ cookieSession: [] }, { oauth: [] }],
    paths: {
      "/api/v1/query": {
        get: {
          operationId: "query",
          parameters: [
            {
              in: "query",
              name: "operation",
              required: true,
              schema: { type: "string", enum: QUERY_NAMES },
            },
            {
              in: "query",
              name: "input",
              schema: {
                type: "string",
                description:
                  "URI-encoded JSON input; bounded to 16k characters",
              },
            },
          ],
          responses: { "200": response, ...errors },
        },
      },
      "/api/v1/commands": {
        post: {
          operationId: "command",
          parameters: [
            {
              in: "header",
              name: "Idempotency-Key",
              required: true,
              schema: { type: "string", minLength: 8, maxLength: 200 },
            },
            {
              in: "header",
              name: "If-Match",
              description:
                "Expected current revision; 0 is valid only for initialization of absent preferences. Existing entity guards remain canonical.",
              schema: { type: "integer", minimum: 0 },
            },
          ],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["command", "input"],
                  additionalProperties: false,
                  properties: {
                    command: { type: "string", enum: COMMAND_NAMES },
                    input: { type: "object" },
                  },
                },
              },
            },
          },
          responses: { "200": response, ...errors },
        },
      },
      "/api/v1/backup/export": {
        get: {
          operationId: "backupExport",
          description:
            "Explicit owner initiated portable backup; backup:export scope required",
          responses: {
            "200": { description: "Private JSON attachment" },
            ...errors,
          },
        },
      },
      "/api/v1/time/export": {
        get: {
          operationId: "timeExport",
          parameters: [
            {
              in: "query",
              name: "month",
              required: true,
              schema: { type: "string", pattern: "^\\d{4}-\\d{2}$" },
            },
            {
              in: "query",
              name: "employer",
              required: true,
              schema: { type: "string", enum: ["Jena", "Seewiesen"] },
            },
          ],
          responses: {
            "200": { description: "Private XLSX attachment" },
            ...errors,
          },
        },
      },
    },
    components: {
      securitySchemes: {
        cookieSession: {
          type: "apiKey",
          in: "cookie",
          name: "better-auth.session_token",
        },
        oauth: {
          type: "oauth2",
          flows: {
            authorizationCode: {
              authorizationUrl: `${appOrigin()}/api/auth/oauth2/authorize`,
              tokenUrl: `${appOrigin()}/api/auth/oauth2/token`,
              scopes: {
                "tasks:read": "Read owner tasks",
                "tasks:write": "Change owner tasks",
              },
            },
          },
        },
      },
    },
  };
}
