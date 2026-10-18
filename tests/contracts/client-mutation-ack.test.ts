import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  clearMutationIntents,
  clearQueryCache,
  command,
  query,
} from "../../features/api";

const receipt = {
  operation_id: "OP-synthetic-server-operation",
  audit_event_id: "E-synthetic-audit",
  entity_id: "T-synthetic-inline",
  version: 2,
  affected_task_ids: ["T-synthetic-inline"],
  readiness_changes: [],
  changed_fields: ["priority"],
  data: { task_id: "T-synthetic-inline", priority: "High", revision: 2 },
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

describe("Client mutation acknowledgement recovery", () => {
  beforeEach(() => {
    clearMutationIntents();
    clearQueryCache();
    vi.stubGlobal(
      "window",
      Object.assign(new EventTarget(), {
        location: {
          pathname: "/tasks",
          origin: "http://localhost:3000",
          assign: vi.fn(),
        },
      }),
    );
  });
  afterEach(() => {
    clearMutationIntents();
    clearQueryCache();
    vi.unstubAllGlobals();
  });

  it("recovers an unreadable success with the identical key, body and revision", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ data: { saved: true } }))
      .mockResolvedValueOnce(Response.json({ data: receipt }));
    vi.stubGlobal("fetch", fetchMock);
    const changed = vi.fn();
    window.addEventListener("lifeos:changed", changed);
    const input = { task_id: "T-synthetic-inline", priority: "High" };
    await expect(command("task_update", input, 1)).rejects.toMatchObject({
      code: "WRITE_UNCONFIRMED",
      details: { cause_code: "INVALID_ACKNOWLEDGEMENT" },
    });
    expect(changed).not.toHaveBeenCalled();
    await expect(command("task_update", input, 1)).resolves.toEqual(receipt);
    const first = fetchMock.mock.calls[0][1];
    const retry = fetchMock.mock.calls[1][1];
    expect(retry.body).toBe(first.body);
    expect(retry.headers["Idempotency-Key"]).toBe(
      first.headers["Idempotency-Key"],
    );
    expect(retry.headers["If-Match"]).toBe("1");
    expect(changed).toHaveBeenCalledOnce();
  });

  it("retains an uncertain transport intent but exposes a definite revision conflict", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("Synthetic dropped response"))
      .mockResolvedValueOnce(Response.json({ data: receipt }))
      .mockResolvedValueOnce(
        Response.json(
          {
            error: {
              code: "REVISION_CONFLICT",
              message: "Synthetic newer revision",
              details: { expected: 2, actual: 3 },
            },
          },
          { status: 409 },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);
    const input = { task_id: "T-synthetic-inline", priority: "High" };
    await expect(command("task_update", input, 1)).rejects.toMatchObject({
      code: "WRITE_UNCONFIRMED",
    });
    await command("task_update", input, 1);
    expect(fetchMock.mock.calls[0][1].headers["Idempotency-Key"]).toBe(
      fetchMock.mock.calls[1][1].headers["Idempotency-Key"],
    );
    await expect(
      command("task_update", { ...input, priority: "Urgent" }, 2),
    ).rejects.toMatchObject({
      code: "REVISION_CONFLICT",
      status: 409,
      details: { expected: 2, actual: 3 },
    } satisfies Partial<ApiError>);
  });

  it.each(["acknowledged", "rejected"] as const)(
    "a late %s write from the previous session cannot replace the new session's identical create intent",
    async (outcome) => {
      const old = deferred<Response>(),
        current = deferred<Response>();
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockReturnValueOnce(old.promise)
        .mockReturnValueOnce(current.promise)
        .mockResolvedValueOnce(Response.json({ data: receipt }));
      vi.stubGlobal("fetch", fetchMock);
      const input = { title: "Synthetic common task title across owners" };
      const oldWrite = command("task_create", input).catch(() => undefined);
      clearMutationIntents();
      clearQueryCache();
      const currentWrite = command("task_create", input).catch(
        (cause: unknown) => cause,
      );
      old.resolve(
        outcome === "acknowledged"
          ? Response.json({ data: receipt })
          : Response.json(
              {
                error: {
                  code: "INVALID_INPUT",
                  message: "Synthetic previous session rejection",
                },
              },
              { status: 400 },
            ),
      );
      await oldWrite;
      current.reject(new TypeError("Synthetic current-session ACK lost"));
      await expect(currentWrite).resolves.toMatchObject({
        code: "WRITE_UNCONFIRMED",
      });
      await expect(command("task_create", input)).resolves.toEqual(receipt);
      expect(fetchMock).toHaveBeenCalledTimes(3);
      const oldRequest = fetchMock.mock.calls[0][1]!;
      const currentRequest = fetchMock.mock.calls[1][1]!;
      const retryRequest = fetchMock.mock.calls[2][1]!;
      const key = (request: RequestInit) =>
        (request.headers as Record<string, string>)["Idempotency-Key"];
      expect(key(currentRequest)).not.toBe(key(oldRequest));
      expect(key(retryRequest)).toBe(key(currentRequest));
      expect(retryRequest.body).toBe(currentRequest.body);
      expect(window.location.assign).not.toHaveBeenCalled();
    },
  );

  it.each(["read", "write"] as const)(
    "an old session's late %s 401 cannot clear the current read cache or uncertain intent or redirect the new session",
    async (kind) => {
      const old = deferred<Response>(),
        current = deferred<Response>();
      const currentTask = {
        task_id: "T-synthetic-new-session",
        title: "Synthetic current owner task",
        revision: 1,
      };
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockReturnValueOnce(old.promise)
        .mockResolvedValueOnce(Response.json({ data: currentTask }))
        .mockReturnValueOnce(current.promise)
        .mockResolvedValueOnce(Response.json({ data: receipt }));
      vi.stubGlobal("fetch", fetchMock);
      const input = { title: "Synthetic same create request across sessions" };
      const stale = (
        kind === "read"
          ? query("preferences_get")
          : command("task_create", input)
      ).catch(() => undefined);
      clearMutationIntents();
      clearQueryCache();
      const readInput = { task_id: currentTask.task_id };
      await expect(query("task_get", readInput)).resolves.toEqual(currentTask);
      const currentWrite = command("task_create", input).catch(
        (cause: unknown) => cause,
      );
      old.resolve(
        Response.json(
          {
            error: {
              code: "UNAUTHENTICATED",
              message: "Synthetic expired previous session",
            },
          },
          { status: 401 },
        ),
      );
      await stale;
      expect(window.location.assign).not.toHaveBeenCalled();
      await expect(query("task_get", readInput)).resolves.toEqual(currentTask);
      expect(fetchMock).toHaveBeenCalledTimes(3);
      current.reject(new TypeError("Synthetic current owner ACK lost"));
      await expect(currentWrite).resolves.toMatchObject({
        code: "WRITE_UNCONFIRMED",
      });
      await command("task_create", input);
      expect(fetchMock).toHaveBeenCalledTimes(4);
      const currentRequest = fetchMock.mock.calls[2][1]!;
      const retryRequest = fetchMock.mock.calls[3][1]!;
      expect(
        (retryRequest.headers as Record<string, string>)["Idempotency-Key"],
      ).toBe(
        (currentRequest.headers as Record<string, string>)["Idempotency-Key"],
      );
      expect(retryRequest.body).toBe(currentRequest.body);
    },
  );

  it("a current session's 401 still redirects to login", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValueOnce(
        Response.json(
          {
            error: {
              code: "UNAUTHENTICATED",
              message: "Synthetic current session expired",
            },
          },
          { status: 401 },
        ),
      ),
    );
    await expect(query("preferences_get")).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
      status: 401,
    });
    expect(window.location.assign).toHaveBeenCalledExactlyOnceWith(
      "http://localhost:3000/login",
    );
  });
});
