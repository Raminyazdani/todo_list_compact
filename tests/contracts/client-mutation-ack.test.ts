import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, clearMutationIntents, command } from "../../features/api";

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

describe("Client mutation acknowledgement recovery", () => {
  beforeEach(() => {
    clearMutationIntents();
    vi.stubGlobal(
      "window",
      Object.assign(new EventTarget(), {
        location: { pathname: "/tasks", origin: "http://localhost:3000" },
      }),
    );
  });
  afterEach(() => {
    clearMutationIntents();
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
});
