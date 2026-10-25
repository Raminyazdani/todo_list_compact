"use client";

import { useCallback, useEffect, useState } from "react";
import type {
  CommandName,
  MutationResult,
  QueryName,
} from "@/shared/contracts";

export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public details: Record<string, unknown> = {},
    public status?: number,
  ) {
    super(message);
  }
}
const pendingReads = new Map<string, Promise<unknown>>();
const recentReads = new Map<string, { value: unknown; until: number }>();
const mutationIntents = new Map<
  string,
  {
    key: string;
    body: string;
    sessionGeneration: number;
    pending?: Promise<MutationResult>;
  }
>();
let readGeneration = 0;
let sessionGeneration = 0;
export function clearMutationIntents() {
  sessionGeneration++;
  mutationIntents.clear();
}
export function clearQueryCache() {
  readGeneration++;
  pendingReads.clear();
  recentReads.clear();
}

async function responseData<T>(
  response: Response,
  requestSessionGeneration: number,
): Promise<T> {
  let body;
  try {
    body = await response.json();
  } catch {
    throw new ApiError(
      "INVALID_RESPONSE",
      "پاسخ سرور قابل بررسی نیست / Server acknowledgement could not be read",
      {},
      response.status,
    );
  }
  if (!response.ok) {
    const currentSession = requestSessionGeneration === sessionGeneration;
    if (response.status === 401 && currentSession) {
      clearQueryCache();
      clearMutationIntents();
    }
    if (
      response.status === 401 &&
      currentSession &&
      !window.location.pathname.startsWith("/login")
    )
      window.location.assign(
        new URL("/login", window.location.origin).toString(),
      );
    throw new ApiError(
      body.error?.code ?? "REQUEST_FAILED",
      body.error?.message ?? "Request failed",
      body.error?.details ?? {},
      response.status,
    );
  }
  return body.data as T;
}

export async function query<T>(
  operation: QueryName,
  input: Record<string, unknown> = {},
): Promise<T> {
  const key = `${operation}:${JSON.stringify(input)}`;
  const cacheable =
    !operation.endsWith("_preview") && operation !== "backup_export";
  const recent = recentReads.get(key);
  if (cacheable && recent && recent.until > Date.now())
    return recent.value as T;
  const existing = pendingReads.get(key);
  if (cacheable && existing) return existing as Promise<T>;
  const generation = readGeneration;
  const requestSessionGeneration = sessionGeneration;
  const url = new URL(
    `/api/v1/query?operation=${operation}&input=${encodeURIComponent(JSON.stringify(input))}`,
    window.location.origin,
  );
  const post = url.href.length > 12000;
  const promise = fetch(
    post ? new URL("/api/v1/query", window.location.origin).href : url.href,
    {
      cache: "no-store",
      credentials: "same-origin",
      ...(post
        ? {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ operation, input }),
          }
        : {}),
    },
  )
    .then((response) => responseData<T>(response, requestSessionGeneration))
    .then((value) => {
      if (cacheable && generation === readGeneration) {
        if (recentReads.size > 100) recentReads.clear();
        recentReads.set(key, { value, until: Date.now() + 3000 });
      }
      return value;
    })
    .finally(() => {
      if (generation === readGeneration) pendingReads.delete(key);
    });
  if (cacheable) pendingReads.set(key, promise);
  return promise;
}

export async function command(
  commandName: CommandName,
  input: Record<string, unknown>,
  revision?: number,
): Promise<MutationResult> {
  const body = JSON.stringify({ command: commandName, input });
  const fingerprint = `${revision ?? "create"}:${body}`;
  const intent = mutationIntents.get(fingerprint) ?? {
    key: crypto.randomUUID(),
    body,
    sessionGeneration,
  };
  if (intent.pending) return intent.pending;
  mutationIntents.set(fingerprint, intent);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Idempotency-Key": intent.key,
  };
  if (revision !== undefined) headers["If-Match"] = String(revision);
  intent.pending = (async () => {
    try {
      const result = await responseData<MutationResult>(
        await fetch("/api/v1/commands", {
          method: "POST",
          headers,
          body: intent.body,
          credentials: "same-origin",
        }),
        intent.sessionGeneration,
      );
      if (
        !result ||
        typeof result.operation_id !== "string" ||
        typeof result.audit_event_id !== "string" ||
        typeof result.entity_id !== "string" ||
        !Number.isInteger(result.version) ||
        result.version < 1 ||
        !Array.isArray(result.affected_task_ids)
      )
        throw new ApiError(
          "INVALID_ACKNOWLEDGEMENT",
          "رسید ذخیره قابل بررسی نیست / Save acknowledgement could not be verified",
        );
      if (mutationIntents.get(fingerprint) === intent)
        mutationIntents.delete(fingerprint);
      if (intent.sessionGeneration === sessionGeneration) {
        clearQueryCache();
        window.dispatchEvent(new Event("lifeos:changed"));
      }
      return result;
    } catch (error) {
      // A lost acknowledgement may follow a successful database commit. Retain
      // this exact intent's key and payload for the user's retry in this session.
      if (
        error instanceof ApiError &&
        error.status &&
        error.status >= 400 &&
        error.status < 500 &&
        error.status !== 408 &&
        error.code !== "IDEMPOTENCY_IN_PROGRESS"
      ) {
        if (mutationIntents.get(fingerprint) === intent)
          mutationIntents.delete(fingerprint);
        throw error;
      }
      throw new ApiError(
        "WRITE_UNCONFIRMED",
        "ذخیره هنوز تأیید نشده؛ برای بررسی نتیجه همین عملیات را دوباره اجرا کن. / Save is unconfirmed. Retry the same action to recover its result.",
        {
          cause_code:
            error instanceof ApiError ? error.code : "TRANSPORT_FAILURE",
        },
      );
    } finally {
      intent.pending = undefined;
    }
  })();
  return intent.pending;
}

export function useQuery<T>(
  operation: QueryName,
  input: Record<string, unknown> = {},
  enabled = true,
) {
  const inputKey = JSON.stringify(input);
  const requestKey = `${operation}:${inputKey}`;
  const [resolvedKey, setResolvedKey] = useState("");
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [version, setVersion] = useState(0);
  const [resolvedVersion, setResolvedVersion] = useState(-1);
  const refresh = useCallback(() => setVersion((value) => value + 1), []);
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    query<T>(operation, JSON.parse(inputKey))
      .then((value) => {
        if (active) {
          setData(value);
          setError(null);
          setResolvedKey(requestKey);
          setResolvedVersion(version);
        }
      })
      .catch((cause: unknown) => {
        if (active) {
          setError(
            cause instanceof Error ? cause.message : "Connection failed",
          );
          setResolvedKey(requestKey);
          setResolvedVersion(version);
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [operation, inputKey, version, enabled, requestKey]);
  useEffect(() => {
    window.addEventListener("lifeos:changed", refresh);
    window.addEventListener("focus", refresh);
    const timer = window.setInterval(refresh, 30000);
    return () => {
      window.removeEventListener("lifeos:changed", refresh);
      window.removeEventListener("focus", refresh);
      window.clearInterval(timer);
    };
  }, [refresh]);
  return {
    data: resolvedKey === requestKey ? data : null,
    loading: enabled && (loading || resolvedKey !== requestKey),
    fetching:
      enabled &&
      (loading || resolvedKey !== requestKey || resolvedVersion !== version),
    error: resolvedKey === requestKey ? error : null,
    refresh,
  };
}

/** Load an entire bounded view instead of silently treating its first page as coverage. */
export function usePagedQuery<T>(
  operation: QueryName,
  input: Record<string, unknown> = {},
  enabled = true,
) {
  const inputKey = JSON.stringify(input);
  const [state, setState] = useState<{
    key: string;
    data: import("@/shared/contracts").PageDTO<T> & {
      source_warnings?: string[];
      source_coverage?: Array<{
        source_id: string | null;
        complete: boolean;
        stale?: boolean;
        unavailable?: boolean;
        last_success_at?: string | null;
      }>;
    };
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fetching, setFetching] = useState(false);
  const [version, setVersion] = useState(0);
  const refresh = useCallback(() => setVersion((value) => value + 1), []);
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    void (async () => {
      await Promise.resolve();
      if (!active) return;
      setFetching(true);
      const items: T[] = [];
      const warnings = new Set<string>();
      const seen = new Set<string>();
      let cursor: string | null = null;
      let last: import("@/shared/contracts").PageDTO<T> | null = null;
      do {
        const page: import("@/shared/contracts").PageDTO<T> & {
          source_warnings?: string[];
          source_coverage?: Array<{
            source_id: string | null;
            complete: boolean;
            stale?: boolean;
            unavailable?: boolean;
            last_success_at?: string | null;
          }>;
        } = await query(operation, {
          ...JSON.parse(inputKey),
          limit: 200,
          cursor,
        });
        if (!active) return;
        items.push(...page.items);
        page.source_warnings?.forEach((warning) => warnings.add(warning));
        last = page;
        cursor = page.next_cursor;
        if (cursor && seen.has(cursor))
          throw new Error("Repeated pagination cursor / صفحه‌بندی تکراری");
        if (cursor) seen.add(cursor);
      } while (cursor);
      if (active && last) {
        setState({
          key: `${operation}:${inputKey}`,
          data: {
            ...last,
            items,
            next_cursor: null,
            source_warnings: [...warnings],
          },
        });
        setError(null);
      }
    })()
      .catch((cause: unknown) => {
        if (active)
          setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (active) setFetching(false);
      });
    return () => {
      active = false;
    };
  }, [operation, inputKey, enabled, version]);
  useEffect(() => {
    const visibleRefresh = () => {
      if (document.visibilityState === "visible") refresh();
    };
    window.addEventListener("lifeos:changed", refresh);
    window.addEventListener("focus", visibleRefresh);
    const timer = window.setInterval(visibleRefresh, 30000);
    return () => {
      window.removeEventListener("lifeos:changed", refresh);
      window.removeEventListener("focus", visibleRefresh);
      window.clearInterval(timer);
    };
  }, [refresh]);
  const data = state?.key === `${operation}:${inputKey}` ? state.data : null;
  return {
    data,
    error,
    loading: enabled && !data && !error,
    fetching,
    refresh,
  };
}
