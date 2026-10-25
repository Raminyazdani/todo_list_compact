"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { authClient } from "@/server/auth/client";
import { Button } from "@/components/ui";
import { clearMutationIntents, clearQueryCache, command } from "./api";
import { TaskRowDraftProvider } from "./task-row-fields";
import {
  readTaskRowIdentity,
  TaskRowIdentityError,
  type TaskRowIdentity,
} from "./task-row-identity";

/** The root layout survives history; the identity belongs to one verified session. */
export function PersistentTaskRowProvider({
  children,
}: {
  children: ReactNode;
}) {
  const pathname = usePathname();
  const session = authClient.useSession();
  const publicPage = [
    "/login",
    "/sign-in",
    "/consent",
    "/about",
    "/privacy",
    "/terms",
  ].includes(pathname);
  const authDenied =
    !!session.error && [401, 403].includes(session.error.status);
  const actorId = session.data?.user.id;
  const sessionId = session.data?.session.id;
  const authenticated = !publicPage && !authDenied && !!actorId && !!sessionId;
  useEffect(() => {
    if (
      !publicPage &&
      !session.isPending &&
      (authDenied || (!session.data && !session.error))
    ) {
      clearQueryCache();
      clearMutationIntents();
      window.location.replace("/login");
    }
  }, [publicPage, session.isPending, session.data, session.error, authDenied]);
  if (publicPage) return <>{children}</>;
  if (!authenticated)
    return (
      <main
        className="loading-state"
        role="status"
        data-testid="task-row-identity-gate"
      >
        <span>
          {session.error?.message ??
            "در حال بررسی فضای خصوصی… / Checking your private workspace…"}
        </span>
        {session.error && (
          <Button onClick={() => void session.refetch()}>
            تلاش دوباره / Retry
          </Button>
        )}
      </main>
    );
  // Background session errors with the same verified data do not destroy drafts.
  // An absent or changed actor/session unmounts and disposes this entire scope.
  return (
    <SessionTaskRows
      key={`${actorId}:${sessionId}`}
      actorId={actorId}
      sessionId={sessionId}
      refetchSession={session.refetch}
    >
      {children}
    </SessionTaskRows>
  );
}

function SessionTaskRows({
  actorId,
  sessionId,
  refetchSession,
  children,
}: {
  actorId: string;
  sessionId: string;
  refetchSession: () => Promise<unknown>;
  children: ReactNode;
}) {
  const [identity, setIdentity] = useState<TaskRowIdentity | null>(null);
  const [error, setError] = useState<TaskRowIdentityError | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [clock, setClock] = useState(0);
  const generation = useRef(0);
  const retrySession = useRef(refetchSession);
  useEffect(() => {
    retrySession.current = refetchSession;
  }, [refetchSession]);
  useEffect(() => {
    const epoch = ++generation.current;
    const abort = new AbortController();
    // A new actor/session must never mount task queries over another scope's
    // cached reads or retryable mutation intents, even during a direct swap.
    clearQueryCache();
    clearMutationIntents();
    readTaskRowIdentity(actorId, abort.signal)
      .then((value) => {
        if (!abort.signal.aborted && generation.current === epoch) {
          setIdentity(value);
          setError(null);
        }
      })
      .catch((cause: unknown) => {
        if (abort.signal.aborted || generation.current !== epoch) return;
        const failure =
          cause instanceof TaskRowIdentityError
            ? cause
            : new TaskRowIdentityError(
                cause instanceof Error ? cause.message : String(cause),
              );
        if (failure.status === 401 || failure.status === 403) {
          clearQueryCache();
          clearMutationIntents();
          void retrySession.current();
          window.location.replace("/login");
        }
        setError(failure);
      });
    return () => {
      abort.abort();
    };
  }, [actorId, attempt]);
  useEffect(() => {
    if (!error?.retryAt) return;
    const timer = window.setTimeout(
      () => setClock(Date.now()),
      Math.max(0, error.retryAt - Date.now()),
    );
    return () => window.clearTimeout(timer);
  }, [error?.retryAt]);
  if (identity)
    return (
      <TaskRowDraftProvider
        key={`${identity.owner_id}:${actorId}:${sessionId}`}
        mutate={command}
      >
        {children}
      </TaskRowDraftProvider>
    );
  const waiting = !!error?.retryAt && error.retryAt > clock;
  return (
    <main
      className="loading-state"
      role="status"
      data-testid="task-row-identity-gate"
    >
      <span>
        {error?.message ??
          "در حال بررسی فضای خصوصی… / Checking your private workspace…"}
      </span>
      {error && (
        <Button
          disabled={waiting}
          onClick={() => {
            setError(null);
            setAttempt((value) => value + 1);
          }}
        >
          تلاش دوباره / Retry
        </Button>
      )}
    </main>
  );
}
