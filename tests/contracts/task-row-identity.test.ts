import { describe, expect, it, vi } from "vitest";
import {
  readTaskRowIdentity,
  TaskRowIdentityError,
} from "@/features/task-row-identity";

function json(data: unknown, status = 200, headers?: HeadersInit) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}
describe("session-bound task row identity", () => {
  it("performs one uncached credentialed GET and accepts only the requested actor's owner", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      json({
        data: { owner_id: "owner-synthetic", actor_id: "actor-synthetic" },
      }),
    );
    const abort = new AbortController();
    await expect(
      readTaskRowIdentity("actor-synthetic", abort.signal, fetcher),
    ).resolves.toEqual({
      owner_id: "owner-synthetic",
      actor_id: "actor-synthetic",
    });
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(
      "/api/v1/query?operation=whoami&input=%7B%7D",
      { cache: "no-store", credentials: "same-origin", signal: abort.signal },
    );
  });
  it("fails closed on a cached or malformed identity for a different actor", async () => {
    for (const data of [
      { owner_id: "other-private-owner", actor_id: "other-actor" },
      { actor_id: "actor-synthetic" },
      { owner_id: "", actor_id: "actor-synthetic" },
    ]) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json({ data }));
      await expect(
        readTaskRowIdentity(
          "actor-synthetic",
          new AbortController().signal,
          fetcher,
        ),
      ).rejects.toThrow("does not match");
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });
  it("preserves unauthorized status and an actual rate-limit delay without automatically retrying", async () => {
    for (const status of [401, 403, 429]) {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          json(
            { error: { message: "Synthetic error" } },
            status,
            status === 429 ? { "Retry-After": "7" } : undefined,
          ),
        );
      const before = Date.now();
      const error = await readTaskRowIdentity(
        "actor-synthetic",
        new AbortController().signal,
        fetcher,
      ).catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(TaskRowIdentityError);
      expect((error as TaskRowIdentityError).status).toBe(status);
      if (status === 429)
        expect((error as TaskRowIdentityError).retryAt).toBeGreaterThanOrEqual(
          before + 7000,
        );
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });
  it("ignores an old owner's late JSON result after the session scope was aborted", async () => {
    let release!: (value: unknown) => void;
    const parsing = new Promise((resolve) => {
      release = resolve;
    });
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue({ ok: true, json: () => parsing } as Response);
    const abort = new AbortController();
    const request = readTaskRowIdentity("old-actor", abort.signal, fetcher);
    await Promise.resolve();
    abort.abort();
    release({ data: { owner_id: "old-private-owner", actor_id: "old-actor" } });
    await expect(request).rejects.toMatchObject({ name: "AbortError" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("does not disable manual recovery for malformed or unbounded advertised delays", async () => {
    for (const header of [
      "1.5",
      "-1",
      "Infinity",
      "1e9",
      "999999999999999999999",
      "61",
      "Wed, 14 Oct 2099 00:00:01 GMT",
    ]) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
        json({ error: { message: "Limited" } }, 429, {
          "Retry-After": header,
        }),
      );
      const error = await readTaskRowIdentity(
        "actor-synthetic",
        new AbortController().signal,
        fetcher,
      ).catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(TaskRowIdentityError);
      expect((error as TaskRowIdentityError).retryAt).toBeUndefined();
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });
});
