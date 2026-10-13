import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { describe, expect, it } from "vitest";
import {
  httpEnabled,
  origin,
  ownerCookie,
  scopedToken,
} from "../contracts/http-fixture";
describe.skipIf(!httpEnabled)(
  "Actual OIDC DCR and PKCE interoperability under the MCP resource",
  () => {
    it("advertised identity scopes register, consent and return owner-bound UserInfo without broadening the resource", async () => {
      const discovery = await fetch(
        origin + "/api/auth/.well-known/openid-configuration",
      );
      expect(discovery.status).toBe(200);
      const metadata = await discovery.json();
      for (const scope of ["openid", "profile", "email"])
        expect(metadata.scopes_supported.includes(scope)).toBe(true);
      const userInfoEndpoint = new URL(metadata.userinfo_endpoint),
        jwks = new URL(metadata.jwks_uri);
      expect(userInfoEndpoint.origin).toBe(origin);
      expect(jwks.origin).toBe(origin);
      const nonce = randomUUID(),
        cookie = await ownerCookie(),
        issued = await scopedToken(
          cookie,
          ["openid", "profile", "email", "tasks:read"],
          { nonce },
        );
      const headers = { Authorization: "Bearer " + issued.accessToken };
      const identityResponse = await fetch(
        origin + "/api/v1/query?operation=whoami",
        { headers },
      );
      expect(identityResponse.status).toBe(200);
      const identity = (await identityResponse.json()).data;
      const userInfo = await fetch(userInfoEndpoint, { headers });
      if (!userInfo.ok) {
        const failure = await userInfo.json().catch(() => ({}));
        const claims = JSON.parse(
          Buffer.from(issued.accessToken.split(".")[1], "base64url").toString(
            "utf8",
          ),
        );
        console.info(
          JSON.stringify({
            userinfo_status: userInfo.status,
            error_code: /^[a-z_]+$/i.test(failure.error ?? "")
              ? failure.error
              : "UNCLASSIFIED",
            description_missing_openid: /openid/i.test(
              failure.error_description ?? failure.message ?? "",
            ),
            description_audience: /audience|resource/i.test(
              failure.error_description ?? failure.message ?? "",
            ),
            access_token_has_openid: String(claims.scope)
              .split(" ")
              .includes("openid"),
            audience_contains_userinfo: [claims.aud]
              .flat()
              .includes(userInfoEndpoint.href),
            id_token_present: !!issued.idToken,
          }),
        );
      }
      expect(userInfo.status).toBe(200);
      const owner = await userInfo.json();
      const expected = JSON.parse(
        await readFile(process.env.TEST_CREDENTIALS_PATH!, "utf8"),
      ) as { email: string };
      expect(
        typeof owner.sub === "string" && owner.sub === identity.actor_id,
      ).toBe(true);
      expect(
        typeof owner.email === "string" &&
          owner.email.toLowerCase() === expected.email.toLowerCase(),
      ).toBe(true);
      expect(
        Object.keys(owner).some((key) => /token|secret|password/i.test(key)),
      ).toBe(false);
      // The successful openid grant under this exact resource must issue an ID token.
      expect(
        typeof issued.idToken === "string" && issued.idToken.length > 0,
      ).toBe(true);
      if (issued.idToken) {
        let payload;
        try {
          payload = (
            await jwtVerify(issued.idToken, createRemoteJWKSet(jwks), {
              issuer: metadata.issuer,
              audience: issued.clientId,
            })
          ).payload;
        } catch {
          throw new Error("OIDC_ID_TOKEN_VERIFICATION_FAILED");
        }
        expect(payload.sub === owner.sub && payload.nonce === nonce).toBe(true);
      }
      const revoke = await fetch(origin + "/api/v1/connections", {
        method: "POST",
        headers: {
          Cookie: cookie,
          Origin: origin,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          client_id: issued.clientId,
          explicit_confirmation: true,
        }),
      });
      expect(revoke.status).toBe(200);
      expect((await revoke.json()).data.revoked).toBe(true);
      expect(Date.now()).toBeLessThan(issued.expiresAt);
      expect((await fetch(userInfoEndpoint, { headers })).status).toBe(401);
      expect(
        (await fetch(origin + "/api/v1/query?operation=whoami", { headers }))
          .status,
      ).toBe(401);
      console.info(
        JSON.stringify({
          oidc_userinfo_owner_bound: true,
          id_token_present: !!issued.idToken,
          requested_resource: "canonical_mcp_only",
          owner_revocation_denies_userinfo: true,
        }),
      );
    }, 60000);
  },
);
