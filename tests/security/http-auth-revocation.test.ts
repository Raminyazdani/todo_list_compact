import { describe, expect, it } from "vitest";
import {
  httpEnabled,
  origin,
  ownerCookie,
  scopedToken,
} from "../contracts/http-fixture";
describe.skipIf(!httpEnabled)(
  "Actual owner consent revocation invalidates an existing OAuth JWT immediately",
  () => {
    it("owner browser lists no tokens, revokes its new test client and the same unexpired JWT is denied", async () => {
      const cookie = await ownerCookie(),
        issued = await scopedToken(cookie, ["tasks:read"]);
      const tokenHeaders = { Authorization: "Bearer " + issued.accessToken };
      expect(
        (
          await fetch(origin + "/api/v1/query?operation=task_search", {
            headers: tokenHeaders,
          })
        ).status,
      ).toBe(200);
      const listing = await fetch(origin + "/api/v1/connections", {
        headers: { Cookie: cookie },
      });
      expect(listing.status).toBe(200);
      const list = (await listing.json()).data;
      expect(list.contains_tokens).toBe(false);
      expect(
        list.items.some(
          (row: { client_id: string }) => row.client_id === issued.clientId,
        ),
      ).toBe(true);
      expect(JSON.stringify(list)).not.toContain(issued.accessToken);
      const denied = await fetch(origin + "/api/v1/connections", {
        method: "POST",
        headers: { ...tokenHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id: issued.clientId,
          explicit_confirmation: true,
        }),
      });
      expect(denied.status).toBe(403);
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
      expect(
        (
          await fetch(origin + "/api/v1/query?operation=task_search", {
            headers: tokenHeaders,
          })
        ).status,
      ).toBe(401);
      const refreshed = await fetch(origin + "/api/v1/connections", {
        headers: { Cookie: cookie },
      });
      expect(refreshed.status).toBe(200);
      expect(
        (await refreshed.json()).data.items.find(
          (row: { client_id: string }) => row.client_id === issued.clientId,
        ).revoked,
      ).toBe(true);
    }, 60000);
  },
);
