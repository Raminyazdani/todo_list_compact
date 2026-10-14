import { describe, expect, it, vi } from "vitest";
import { boundedSignIn } from "../../scripts/ops/bounded-signin.mjs";

const origin = "http://localhost:3000";
const credentials = {
  email: "synthetic-private@example.invalid",
  password: "synthetic-private-password",
};
function fixture(responses: Response[]) {
  let instant = Date.parse("2026-10-14T00:00:00Z");
  const fetch = vi.fn(async () => responses.shift()!);
  const sleep = vi.fn(async (milliseconds: number) => {
    instant += milliseconds;
  });
  return { fetch, sleep, now: () => instant };
}
describe("Bounded verification sign-in respects observed server rate limits", () => {
  it("retries only a real 429 after integer Retry-After plus boundary margin, preserving private request and manual redirects", async () => {
    const accepted = Response.json(
      {},
      { headers: { "Set-Cookie": "synthetic=private; HttpOnly" } },
    );
    const dependencies = fixture([
      new Response("limited", {
        status: 429,
        headers: { "Retry-After": "10" },
      }),
      accepted,
    ]);
    expect(await boundedSignIn(origin, credentials, dependencies)).toBe(
      accepted,
    );
    expect(dependencies.sleep).toHaveBeenCalledExactlyOnceWith(10250);
    expect(dependencies.fetch).toHaveBeenCalledTimes(2);
    for (const [url, request] of dependencies.fetch.mock.calls as unknown as [
      string,
      RequestInit,
    ][]) {
      expect(url).toBe(origin + "/api/auth/sign-in/email");
      expect(request.redirect).toBe("manual");
      expect(JSON.parse(String(request.body))).toEqual(credentials);
      expect(request.headers).toEqual({
        "Content-Type": "application/json",
        Origin: origin,
      });
    }
  });
  it("supports the actual vendor X-Retry-After and standard HTTP-date headers without arbitrary Date.parse coercion", async () => {
    for (const headers of [
      { "X-Retry-After": "1" },
      { "Retry-After": "Wed, 14 Oct 2026 00:00:01 GMT" },
    ] as Record<string, string>[]) {
      const dependencies = fixture([
        new Response(null, { status: 429, headers }),
        new Response(null),
      ]);
      expect(
        (await boundedSignIn(origin, credentials, dependencies)).status,
      ).toBe(200);
      expect(dependencies.sleep).toHaveBeenCalledExactlyOnceWith(1250);
    }
  });
  it("401/403/invalid input/server failure/redirect responses are never retried or their bodies consumed", async () => {
    for (const status of [400, 401, 403, 500, 302]) {
      const denied = new Response("preserved denial", {
        status,
        headers: { "Retry-After": "1" },
      });
      const dependencies = fixture([denied]);
      expect(await boundedSignIn(origin, credentials, dependencies)).toBe(
        denied,
      );
      expect(dependencies.fetch).toHaveBeenCalledOnce();
      expect(dependencies.sleep).not.toHaveBeenCalled();
      expect(await denied.text()).toBe("preserved denial");
    }
  });
  it("missing, malformed, fractional, stale and absurd advertised waits fail closed without a blind retry", async () => {
    for (const header of [
      undefined,
      "",
      "-1",
      "1.5",
      "1e2",
      "tomorrow",
      "30",
      "179191196429327",
      "Tue, 13 Oct 2026 23:59:59 GMT",
    ]) {
      const denied = new Response("preserved", {
        status: 429,
        headers: header === undefined ? {} : { "Retry-After": header },
      });
      const dependencies = fixture([denied]);
      expect(await boundedSignIn(origin, credentials, dependencies)).toBe(
        denied,
      );
      expect(dependencies.fetch).toHaveBeenCalledOnce();
      expect(dependencies.sleep).not.toHaveBeenCalled();
      expect(await denied.text()).toBe("preserved");
    }
  });
  it("an invalid standard header cannot be replaced by a valid vendor header to bypass admission", async () => {
    const denied = new Response(null, {
      status: 429,
      headers: { "Retry-After": "absurd", "X-Retry-After": "1" },
    });
    const dependencies = fixture([denied]);
    expect(await boundedSignIn(origin, credentials, dependencies)).toBe(denied);
    expect(dependencies.sleep).not.toHaveBeenCalled();
  });
  it("at most three attempts are made and the final real denial is returned intact", async () => {
    const last = new Response("denied", {
      status: 429,
      headers: { "Retry-After": "1" },
    });
    const dependencies = fixture([
      new Response(null, { status: 429, headers: { "Retry-After": "1" } }),
      new Response(null, { status: 429, headers: { "Retry-After": "1" } }),
      last,
    ]);
    expect(await boundedSignIn(origin, credentials, dependencies)).toBe(last);
    expect(dependencies.fetch).toHaveBeenCalledTimes(3);
    expect(dependencies.sleep).toHaveBeenCalledTimes(2);
    expect(await last.text()).toBe("denied");
  });
  it("the whole retry budget is thirty seconds, including earlier waits", async () => {
    const last = new Response("denied", {
      status: 429,
      headers: { "Retry-After": "10" },
    });
    const dependencies = fixture([
      new Response(null, { status: 429, headers: { "Retry-After": "20" } }),
      last,
    ]);
    expect(await boundedSignIn(origin, credentials, dependencies)).toBe(last);
    expect(dependencies.fetch).toHaveBeenCalledTimes(2);
    expect(dependencies.sleep).toHaveBeenCalledExactlyOnceWith(20250);
  });
  it("network errors are not retried or allowed to echo a credential-bearing message", async () => {
    const request = vi.fn(async () => {
      throw new Error(JSON.stringify(credentials));
    });
    const sleep = vi.fn();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(
        boundedSignIn(origin, credentials, { fetch: request, sleep }),
      ).rejects.toThrow(/^SIGN_IN_TRANSPORT_FAILED$/);
      expect(request).toHaveBeenCalledOnce();
      expect(sleep).not.toHaveBeenCalled();
      expect(log).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
  });
  it("embedded URL credentials or noncanonical origin/path are rejected before any credential-bearing request", async () => {
    for (const target of [
      "https://private:secret@example.invalid",
      origin + "/path",
      "file:///private",
    ]) {
      const dependencies = fixture([]);
      await expect(
        boundedSignIn(target, credentials, dependencies),
      ).rejects.toThrow("SIGN_IN_INPUT_INVALID");
      expect(dependencies.fetch).not.toHaveBeenCalled();
    }
  });
});
