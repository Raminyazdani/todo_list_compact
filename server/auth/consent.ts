import { verifyOAuthQueryParams } from "@better-auth/oauth-provider";
import { getAuth } from "./config";

export async function getConsentDetails(oauthQuery: string) {
  const auth = getAuth();
  const context = await auth.$context;
  if (
    !oauthQuery ||
    oauthQuery.length > 16000 ||
    !(await verifyOAuthQueryParams(oauthQuery, context.secret))
  )
    return null;
  const params = new URLSearchParams(oauthQuery);
  return {
    client_id: params.get("client_id"),
    scopes: (params.get("scope") ?? "").split(" ").filter(Boolean),
    resource: params.get("resource"),
  };
}
