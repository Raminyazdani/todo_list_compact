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
    pending?: Promise<MutationResult>;
  }
>();
let readGeneration = 0;
export function clearMutationIntents() {
  mutationIntents.clear();
}
export function clearQueryCache() {
  readGeneration++;
  pendingReads.clear();
  recentReads.clear();
}

async function responseData<T>(response: Response): Promise<T> {
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
    if (response.status === 401) {
      clearQueryCache();
      clearMutationIntents();
    }
    if (
      response.status === 401 &&
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
    .then(responseData<T>)
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
      );
      mutationIntents.delete(fingerprint);
      clearQueryCache();
      window.dispatchEvent(new Event("lifeos:changed"));
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
        mutationIntents.delete(fingerprint);
        throw error;
      }
      throw new ApiError(
        "WRITE_UNCONFIRMED",
        "ذخیره هنوز تأیید نشده؛ برای بررسی نتیجه همین عملیات را دوباره اجرا کن. / Save is unconfirmed. Retry the same action to recover its result.",
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
