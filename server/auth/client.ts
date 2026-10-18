"use client";
import { createAuthClient } from "better-auth/react";
import { passkeyClient } from "@better-auth/passkey/client";
import { oauthProviderClient } from "@better-auth/oauth-provider/client";
export const authClient = createAuthClient({
  sessionOptions: { refetchOnWindowFocus: false },
  plugins: [passkeyClient(), oauthProviderClient()],
});
