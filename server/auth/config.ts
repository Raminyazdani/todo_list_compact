import { betterAuth } from "better-auth";
import { nextCookies } from "better-auth/next-js";
import { jwt } from "better-auth/plugins/jwt";
import { passkey } from "@better-auth/passkey";
import { oauthProvider } from "@better-auth/oauth-provider";
import { getAuthPool } from "./db";

export const OWNER_SCOPES = [
  "tasks:read",
  "tasks:write",
  "projects:read",
  "projects:write",
  "files:read",
  "files:write",
  "calendar:read",
  "calendar:write",
  "time:read",
  "time:write",
  "activity:read",
  "backup:export",
  "admin:manage",
] as const;
export function appOrigin() {
  const configured = process.env.BETTER_AUTH_URL;
  if (configured) return new URL(configured).origin;
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return "http://localhost:3000";
}

export function createAuth(bootstrap = false) {
  const origin = appOrigin();
  const ownerEmail = process.env.OWNER_EMAIL?.toLowerCase();
  if (!ownerEmail || !process.env.OWNER_ID || !process.env.BETTER_AUTH_SECRET)
    throw new Error("AUTH_NOT_CONFIGURED");
  const resource = `${origin}/api/mcp`;
  return betterAuth({
    appName: "Ramin Life OS",
    baseURL: origin,
    secret: process.env.BETTER_AUTH_SECRET,
    database: getAuthPool(),
    logger: { disabled: true },
    trustedOrigins: [origin],
    disabledPaths: ["/token"],
    emailAndPassword: {
      enabled: true,
      disableSignUp: !bootstrap,
      minPasswordLength: 16,
      maxPasswordLength: 128,
      autoSignIn: false,
    },
    socialProviders: {
      ...(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET
        ? {
            github: {
              clientId: process.env.GITHUB_CLIENT_ID,
              clientSecret: process.env.GITHUB_CLIENT_SECRET,
              disableSignUp: true,
            },
          }
        : {}),
      ...(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
        ? {
            google: {
              clientId: process.env.GOOGLE_CLIENT_ID,
              clientSecret: process.env.GOOGLE_CLIENT_SECRET,
              disableSignUp: true,
              accessType: "offline",
              prompt: "select_account consent",
              includeGrantedScopes: false,
              scope: ["https://www.googleapis.com/auth/calendar.readonly"],
            },
          }
        : {}),
    },
    account: { encryptOAuthTokens: true },
    session: {
      expiresIn: 60 * 60 * 24 * 7,
      updateAge: 60 * 60 * 12,
      cookieCache: { enabled: false },
    },
    rateLimit: { enabled: true, storage: "database", window: 60, max: 60 },
    databaseHooks: {
      user: {
        create: {
          before: async (user) => {
            if (user.email.toLowerCase() !== ownerEmail)
              throw new Error("OWNER_ONLY");
            return { data: user };
          },
        },
      },
    },
    plugins: [
      jwt(),
      passkey({
        rpName: "Ramin Life OS",
        rpID: new URL(origin).hostname,
        origin,
      }),
      oauthProvider({
        loginPage: "/sign-in",
        consentPage: "/consent",
        scopes: [
          "openid",
          "profile",
          "email",
          "offline_access",
          ...OWNER_SCOPES,
        ],
        accessTokenExpiresIn: 300,
        allowDynamicClientRegistration: true,
        allowUnauthenticatedClientRegistration: true,
        clientRegistrationDefaultScopes: ["openid", "tasks:read"],
        clientRegistrationAllowedScopes: [
          ...OWNER_SCOPES,
          "openid",
          "profile",
          "email",
          "offline_access",
        ],
        resources: [
          {
            identifier: resource,
            allowedScopes: [...OWNER_SCOPES],
            accessTokenTtl: 300,
          },
        ],
        clientRegistrationDefaultResources: [resource],
        enforcePerClientResources: true,
      }),
      nextCookies(),
    ],
  });
}
let auth: ReturnType<typeof createAuth> | undefined;
export function getAuth() {
  return (auth ??= createAuth());
}
