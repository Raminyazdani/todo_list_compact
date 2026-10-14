import { describe, expect, it, vi } from "vitest";
import { boundedRegistration } from "./bounded-registration";

const origin = "http://localhost:3000";
const metadata = {
  client_name: "Synthetic scope fixture",
  application_type: "native",
  redirect_uris: ["http://127.0.0.1:39875/callback"],
  token_endpoint_auth_method: "none",
  grant_types: ["authorization_code"],
  response_types: ["code"],
  scope: "calendar:read",
  resources: [origin + "/api/mcp"],
};
function fixture(responses: Response[]) {
  let instant = Date.parse("2026-10-14T00:00:00Z");
  const fetch = vi.fn(async () => responses.shift()!);
  const sleep = vi.fn(async (milliseconds: number) => {
    instant += milliseconds;
  });
  return { fetch, sleep, now: () => instant };
}

describe("Bounded fixture registration respects the real five-per-minute DCR policy", () => {
  it("waits for vendor 60-second rejection, then preserves exact scopes and request metadata", async () => {
    const accepted = Response.json({ client_id: "synthetic-client" });
    const dependencies = fixture([
      new Response("limited", {
        status: 429,
        headers: { "X-Retry-After": "60" },
      }),
      accepted,
    ]);
    expect(await boundedRegistration(origin, metadata, dependencies)).toBe(
      accepted,
    );
    expect(dependencies.sleep).toHaveBeenCalledExactlyOnceWith(60250);
    expect(dependencies.fetch).toHaveBeenCalledTimes(2);
    for (const [url, request] of dependencies.fetch.mock.calls as unknown as [
      string,
      RequestInit,
    ][]) {
      expect(url).toBe(origin + "/api/auth/oauth2/register");
      expect(request.method).toBe("POST");
      expect(request.redirect).toBe("manual");
      expect(request.headers).toEqual({ "Content-Type": "application/json" });
      expect(JSON.parse(String(request.body))).toEqual(metadata);
      expect(request.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it("accepts strict standard integer and HTTP-date Retry-After", async () => {
    for (const headers of [
      { "Retry-After": "1" },
      { "Retry-After": "Wed, 14 Oct 2026 00:00:01 GMT" },
    ] as Record<string, string>[]) {
      const dependencies = fixture([
        new Response(null, { status: 429, headers }),
        new Response(null),
      ]);
      expect(
        (await boundedRegistration(origin, metadata, dependencies)).status,
      ).toBe(200);
      expect(dependencies.sleep).toHaveBeenCalledExactlyOnceWith(1250);
    }
  });

  it("preserves every non-429 response without retrying or consuming its body", async () => {
    for (const status of [200, 201, 302, 400, 401, 403, 500, 503]) {
      const response = new Response("unchanged", {
        status,
        headers: { "X-Retry-After": "1" },
      });
      const dependencies = fixture([response]);
      expect(await boundedRegistration(origin, metadata, dependencies)).toBe(
        response,
      );
      expect(dependencies.fetch).toHaveBeenCalledTimes(1);
      expect(dependencies.sleep).not.toHaveBeenCalled();
      expect(response.bodyUsed).toBe(false);
    }
  });

  it("rejects missing, malformed, unsafe, stale and oversized wait headers without retry", async () => {
    for (const header of [
      undefined,
      "",
      "absurd",
      "1.5",
      "-1",
      "1e1",
      "66",
      "9007199254740992",
      "Tue, 13 Oct 2026 23:59:59 GMT",
      "Wed, 31 Feb 2027 00:00:00 GMT",
      "Tue, 14 Oct 2026 00:00:01 GMT",
    ]) {
      const denied = new Response("preserved denial", {
        status: 429,
        headers: header === undefined ? {} : { "X-Retry-After": header },
      });
      const dependencies = fixture([denied]);
      expect(await boundedRegistration(origin, metadata, dependencies)).toBe(
        denied,
      );
      expect(dependencies.fetch).toHaveBeenCalledTimes(1);
      expect(dependencies.sleep).not.toHaveBeenCalled();
      expect(denied.bodyUsed).toBe(false);
    }
    const denied = new Response(null, {
      status: 429,
      headers: { "Retry-After": "malformed", "X-Retry-After": "1" },
    });
    const dependencies = fixture([denied]);
    expect(await boundedRegistration(origin, metadata, dependencies)).toBe(
      denied,
    );
    expect(dependencies.fetch).toHaveBeenCalledTimes(1);
  });

  it("permits no more than two rejected retries and never exceeds the shared 65-second budget", async () => {
    const last = new Response("final denial", {
      status: 429,
      headers: { "X-Retry-After": "1" },
    });
    const dependencies = fixture([
      new Response(null, { status: 429, headers: { "X-Retry-After": "1" } }),
      new Response(null, { status: 429, headers: { "X-Retry-After": "1" } }),
      last,
    ]);
    expect(await boundedRegistration(origin, metadata, dependencies)).toBe(
      last,
    );
    expect(dependencies.fetch).toHaveBeenCalledTimes(3);
    expect(dependencies.sleep).toHaveBeenCalledTimes(2);
    expect(last.bodyUsed).toBe(false);

    const overBudget = new Response("budget denial", {
      status: 429,
      headers: { "X-Retry-After": "40" },
    });
    const cumulative = fixture([
      new Response(null, { status: 429, headers: { "X-Retry-After": "30" } }),
      overBudget,
    ]);
    expect(await boundedRegistration(origin, metadata, cumulative)).toBe(
      overBudget,
    );
    expect(cumulative.fetch).toHaveBeenCalledTimes(2);
    expect(cumulative.sleep).toHaveBeenCalledExactlyOnceWith(30250);
    expect(overBudget.bodyUsed).toBe(false);
  });

  it("never retries an uncertain transport error and does not expose its private details", async () => {
    const request = vi.fn(async () => {
      throw new Error("synthetic private registration request content");
    });
    const sleep = vi.fn();
    await expect(
      boundedRegistration(origin, metadata, { fetch: request, sleep }),
    ).rejects.toThrow(/^OAUTH_REGISTRATION_TRANSPORT_FAILED$/);
    expect(request).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});
