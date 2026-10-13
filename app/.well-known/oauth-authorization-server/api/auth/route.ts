import { oauthProviderAuthServerMetadata } from "@better-auth/oauth-provider";
import { getAuth } from "@/server/auth/config";
export async function GET(request: Request) {
  return oauthProviderAuthServerMetadata(getAuth())(request);
}
