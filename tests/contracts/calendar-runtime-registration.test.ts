import { describe, expect, it, vi } from "vitest";

const { registerCalendarRuntimeGrant } = await import(
  new URL("../../scripts/ops/calendar-runtime-smoke.mjs", import.meta.url).href
);
const origin = "http://localhost:3000";
const metadata = {
  client_name: "Synthetic calendar runtime QA fixed-run writer",
  application_type: "native",
  redirect_uris: ["http://127.0.0.1:39876/callback"],
  token_endpoint_auth_method: "none",
  grant_types: ["authorization_code"],
  response_types: ["code"],
  scope: "calendar:read time:read time:write",
  resources: [origin + "/api/mcp"],
};
function fixture(responses: Response[]) {
  let instant = Date.parse("2026-10-16T00:00:00Z");
  const grant: Record<string, unknown> = { role: "writer" };
  const snapshots: Record<string, unknown>[] = [];
  const save = vi.fn(async () => {
    snapshots.push(structuredClone(grant));
  });
  const fetch = vi.fn(async (url: string, request: RequestInit) => {
    expect(snapshots[0]?.registration_state).toBe("attempted");
    expect(url).toBe(origin + "/api/auth/oauth2/register");
    expect(request.method).toBe("POST");
    return responses.shift()!;
  });
  const sleep = vi.fn(async (milliseconds: number) => {
    instant += milliseconds;
  });
  return {
    grant,
    save,
    snapshots,
    dependencies: { fetch, sleep, now: () => instant },
  };
}

describe("Operational calendar DCR retains exact grants across bounded rate rejection", () => {
  it("waits out the real 60-second limit and confirms the same pinned client name, body and scope", async () => {
    const state = fixture([
      new Response("limited", {
        status: 429,
        headers: { "X-Retry-After": "60" },
      }),
      Response.json(
        { client_id: "synthetic-retained-client" },
        { status: 201 },
      ),
    ]);
    await registerCalendarRuntimeGrant(
      origin,
      state.grant,
      metadata,
      state.save,
      state.dependencies,
    );
    expect(state.dependencies.sleep).toHaveBeenCalledExactlyOnceWith(60250);
    expect(state.dependencies.fetch).toHaveBeenCalledTimes(2);
    const requests = state.dependencies.fetch.mock.calls;
    expect(requests[0][1].body).toBe(requests[1][1].body);
    expect(JSON.parse(String(requests[0][1].body))).toEqual(metadata);
    expect(
      requests.every(([url]) => url === origin + "/api/auth/oauth2/register"),
    ).toBe(true);
    expect(state.snapshots.map((value) => value.registration_state)).toEqual([
      "attempted",
      "confirmed",
    ]);
    expect(state.grant.registration_metadata).toEqual(metadata);
    expect(state.grant.client_id).toBe("synthetic-retained-client");
  });

  it("keeps a final known 429 rejected after at most two retries and leaves metadata pinned", async () => {
    const state = fixture(
      Array.from(
        { length: 3 },
        () =>
          new Response(null, { status: 429, headers: { "Retry-After": "1" } }),
      ),
    );
    await expect(
      registerCalendarRuntimeGrant(
        origin,
        state.grant,
        metadata,
        state.save,
        state.dependencies,
      ),
    ).rejects.toThrow("CALENDAR_RUNTIME_DCR_REJECTED_429");
    expect(state.dependencies.fetch).toHaveBeenCalledTimes(3);
    expect(state.dependencies.sleep).toHaveBeenCalledTimes(2);
    expect(state.grant.registration_state).toBe("rejected");
    expect(state.grant.registration_metadata).toEqual(metadata);
    await expect(
      registerCalendarRuntimeGrant(
        origin,
        state.grant,
        { ...metadata, client_name: "Changed intent" },
        state.save,
        state.dependencies,
      ),
    ).rejects.toThrow("CALENDAR_RUNTIME_DCR_RETAINED_METADATA_MISMATCH");
    expect(state.dependencies.fetch).toHaveBeenCalledTimes(3);
  });

  it.each([undefined, "malformed", "66"])(
    "does not invent a retry for unsafe Retry-After %s",
    async (header) => {
      const state = fixture([
        new Response(null, {
          status: 429,
          headers: header === undefined ? {} : { "Retry-After": header },
        }),
      ]);
      await expect(
        registerCalendarRuntimeGrant(
          origin,
          state.grant,
          metadata,
          state.save,
          state.dependencies,
        ),
      ).rejects.toThrow("CALENDAR_RUNTIME_DCR_REJECTED_429");
      expect(state.dependencies.fetch).toHaveBeenCalledTimes(1);
      expect(state.dependencies.sleep).not.toHaveBeenCalled();
    },
  );

  it.each([408, 500, 503])(
    "retains an uncertain HTTP %s without retrying within or across invocations",
    async (status) => {
      const state = fixture([
        new Response(null, { status, headers: { "Retry-After": "1" } }),
      ]);
      for (let attempt = 0; attempt < 2; attempt++)
        await expect(
          registerCalendarRuntimeGrant(
            origin,
            state.grant,
            metadata,
            state.save,
            state.dependencies,
          ),
        ).rejects.toThrow(
          "CALENDAR_RUNTIME_DCR_OUTCOME_UNKNOWN_RETAIN_JOURNAL",
        );
      expect(state.dependencies.fetch).toHaveBeenCalledTimes(1);
      expect(state.dependencies.sleep).not.toHaveBeenCalled();
      expect(state.grant.registration_state).toBe("attempted");
      expect(state.save).toHaveBeenCalledTimes(1);
    },
  );

  it("never repeats transport uncertainty or exposes its private error", async () => {
    const state = fixture([]);
    state.dependencies.fetch.mockRejectedValue(
      new Error("synthetic private metadata accepted before disconnect"),
    );
    for (let attempt = 0; attempt < 2; attempt++)
      await expect(
        registerCalendarRuntimeGrant(
          origin,
          state.grant,
          metadata,
          state.save,
          state.dependencies,
        ),
      ).rejects.toThrow(
        /^CALENDAR_RUNTIME_DCR_OUTCOME_UNKNOWN_RETAIN_JOURNAL$/,
      );
    expect(state.dependencies.fetch).toHaveBeenCalledTimes(1);
    expect(state.dependencies.sleep).not.toHaveBeenCalled();
    expect(state.grant.registration_state).toBe("attempted");
  });
});
