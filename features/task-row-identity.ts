export interface TaskRowIdentity {
  owner_id: string;
  actor_id: string;
}
export class TaskRowIdentityError extends Error {
  constructor(
    message: string,
    public status?: number,
    public retryAt?: number,
  ) {
    super(message);
  }
}

/** One authenticated read. It never shares a cache across actor/session scopes. */
export async function readTaskRowIdentity(
  actorId: string,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<TaskRowIdentity> {
  signal.throwIfAborted();
  const response = await fetcher(
    "/api/v1/query?operation=whoami&input=%7B%7D",
    {
      cache: "no-store",
      credentials: "same-origin",
      signal,
    },
  );
  signal.throwIfAborted();
  const body = await response.json().catch(() => null);
  signal.throwIfAborted();
  if (!response.ok) {
    const retryAfter = response.headers.get("Retry-After");
    const seconds =
      retryAfter !== null && /^\d+$/.test(retryAfter)
        ? Number(retryAfter)
        : NaN;
    // Only a strict, short integer delay affects the manual Retry button.
    // Unsupported date/fraction/oversized values never create a long timer.
    const retryAt =
      Number.isSafeInteger(seconds) && seconds >= 0 && seconds <= 60
        ? Date.now() + seconds * 1000
        : undefined;
    throw new TaskRowIdentityError(
      body?.error?.message ??
        "بررسی فضای خصوصی انجام نشد / Private workspace verification failed",
      response.status,
      retryAt !== undefined && Number.isFinite(retryAt) ? retryAt : undefined,
    );
  }
  const identity: unknown = body?.data;
  if (
    !identity ||
    typeof identity !== "object" ||
    !("owner_id" in identity) ||
    typeof identity.owner_id !== "string" ||
    !identity.owner_id ||
    !("actor_id" in identity) ||
    identity.actor_id !== actorId
  )
    throw new TaskRowIdentityError(
      "هویت پاسخ با نشست فعال یکسان نیست / Identity does not match the active session",
    );
  return { owner_id: identity.owner_id, actor_id: actorId };
}
