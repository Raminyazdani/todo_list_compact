import { getAuthPool } from "./db";
import { DomainError, type Principal } from "../../shared/contracts";
function ownerBrowser(principal: Principal) {
  if (principal.channel !== "UI" || !principal.scopes.includes("admin:manage"))
    throw new DomainError(
      "INSUFFICIENT_PERMISSIONS",
      "مدیریت اتصال‌ها به نشست مرورگر صاحب حساب نیاز دارد.",
      {},
      403,
    );
}
export async function listOwnerConnections(principal: Principal) {
  ownerBrowser(principal);
  const result = await getAuthPool().query(
    `SELECT c."clientId" AS client_id,c.name,COALESCE(c.disabled,false) AS revoked,o.scopes AS granted_scopes,o."createdAt" AS granted_at,o."updatedAt" AS updated_at
    FROM "oauthConsent" o JOIN "oauthClient" c ON c."clientId"=o."clientId" WHERE o."userId"=$1 ORDER BY o."updatedAt" DESC LIMIT 200`,
    [principal.actorId],
  );
  return { items: result.rows, limit: 200, contains_tokens: false };
}
export async function revokeOwnerConnection(
  clientId: string,
  principal: Principal,
) {
  ownerBrowser(principal);
  if (!/^[A-Za-z0-9_-]{8,200}$/.test(clientId))
    throw new DomainError("INVALID_INPUT", "Invalid OAuth client identifier");
  const connection = await getAuthPool().connect();
  try {
    await connection.query("BEGIN");
    const grant = await connection.query(
      `SELECT c."clientId" FROM "oauthClient" c WHERE c."clientId"=$1 AND EXISTS(SELECT 1 FROM "oauthConsent" o WHERE o."clientId"=c."clientId" AND o."userId"=$2) FOR UPDATE`,
      [clientId, principal.actorId],
    );
    if (!grant.rowCount)
      throw new DomainError(
        "ENTITY_NOT_FOUND",
        "اتصالِ تأییدشدهٔ این حساب پیدا نشد.",
        {},
        404,
      );
    await connection.query(
      'UPDATE "oauthClient" SET disabled=true,"updatedAt"=now() WHERE "clientId"=$1',
      [clientId],
    );
    await connection.query(
      'UPDATE "oauthRefreshToken" SET revoked=COALESCE(revoked,now()) WHERE "clientId"=$1 AND "userId"=$2',
      [clientId, principal.actorId],
    );
    await connection.query(
      'DELETE FROM "oauthAccessToken" WHERE "clientId"=$1 AND "userId"=$2',
      [clientId, principal.actorId],
    );
    await connection.query("COMMIT");
    return { client_id: clientId, revoked: true };
  } catch (error) {
    await connection.query("ROLLBACK");
    throw error;
  } finally {
    connection.release();
  }
}
