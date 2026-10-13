import { headers } from "next/headers";
import { createAuthClient } from "better-auth/client";
import { oauthProviderResourceClient } from "@better-auth/oauth-provider/resource-client";
import type { Principal } from "@/shared/contracts";
import { DomainError } from "@/shared/contracts";
import { appOrigin, getAuth, OWNER_SCOPES } from "./config";
import { getAuthPool } from "./db";

export async function getOwnerSession() {
  const session = await getAuth().api.getSession({ headers: await headers() });
  if (
    !session ||
    session.user.email.toLowerCase() !== process.env.OWNER_EMAIL?.toLowerCase()
  )
    return null;
  return session;
}
export async function requirePrincipal(
  request: Request,
  channel: Principal["channel"] = "UI",
): Promise<Principal> {
  const ownerId = process.env.OWNER_ID;
  if (!ownerId)
    throw new DomainError(
      "INSUFFICIENT_PERMISSIONS",
      "Authentication is not configured",
      {},
      503,
    );
  if (request.headers.has("authorization")) {
    const origin = appOrigin();
    const client = createAuthClient({
      plugins: [oauthProviderResourceClient()],
    });
    let payload;
    try {
      // DPoP requests fail closed until shared replay storage is enabled. Bearer JWTs remain audience-bound.
      if (request.headers.get("authorization")?.startsWith("DPoP "))
        throw new Error("DPoP unavailable");
      payload = await client.verifyAccessTokenRequest(request, {
        verifyOptions: {
          issuer: `${origin}/api/auth`,
          audience: `${origin}/api/mcp`,
        },
        jwksUrl: `${origin}/api/auth/jwks`,
      });
    } catch {
      throw new DomainError(
        "INSUFFICIENT_PERMISSIONS",
        "Invalid or expired access token",
        {},
        401,
      );
    }
    const userId = payload.sub;
    if (!userId)
      throw new DomainError(
        "INSUFFICIENT_PERMISSIONS",
        "User token required",
        {},
        403,
      );
    const user = await getAuthPool().query(
      'SELECT id,email FROM "user" WHERE id=$1',
      [userId],
    );
    if (
      user.rows[0]?.email?.toLowerCase() !==
      process.env.OWNER_EMAIL?.toLowerCase()
    )
      throw new DomainError(
        "INSUFFICIENT_PERMISSIONS",
        "Owner access required",
        {},
        403,
      );
    if (typeof payload.sid === "string") {
      const sessions = await getAuthPool().query(
        'SELECT id FROM "session" WHERE id=$1 AND "userId"=$2 AND "expiresAt">now()',
        [payload.sid, userId],
      );
      if (!sessions.rowCount)
        throw new DomainError(
          "INSUFFICIENT_PERMISSIONS",
          "Session revoked",
          {},
          401,
        );
    }
    if (typeof payload.client_id !== "string")
      throw new DomainError(
        "INSUFFICIENT_PERMISSIONS",
        "OAuth client-bound token required",
        {},
        401,
      );
    const registered = await getAuthPool().query(
      'SELECT disabled FROM "oauthClient" WHERE "clientId"=$1',
      [payload.client_id],
    );
    if (!registered.rowCount || registered.rows[0]?.disabled === true)
      throw new DomainError(
        "INSUFFICIENT_PERMISSIONS",
        "OAuth client revoked",
        {},
        401,
      );
    return {
      ownerId,
      actorId: userId,
      channel: channel === "UI" ? "MCP" : channel,
      scopes: typeof payload.scope === "string" ? payload.scope.split(" ") : [],
    };
  }
  const session = await getAuth().api.getSession({ headers: request.headers });
  if (
    !session ||
    session.user.email.toLowerCase() !== process.env.OWNER_EMAIL?.toLowerCase()
  )
    throw new DomainError(
      "INSUFFICIENT_PERMISSIONS",
      "Sign in required",
      {},
      401,
    );
  if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) {
    const origin = request.headers.get("origin");
    if (!origin || origin !== appOrigin())
      throw new DomainError(
        "INSUFFICIENT_PERMISSIONS",
        "Origin rejected",
        {},
        403,
      );
  }
  return { ownerId, actorId: session.user.id, channel, scopes: OWNER_SCOPES };
}
