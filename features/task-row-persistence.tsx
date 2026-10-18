"use client";

import { useEffect, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { authClient } from "@/server/auth/client";
import { Button } from "@/components/ui";
import { clearQueryCache, command, useQuery } from "./api";
import { TaskRowDraftProvider } from "./task-row-fields";

/** The root layout survives App Router history navigation. No browser storage or singleton. */
export function PersistentTaskRowProvider({
  children,
}: {
  children: ReactNode;
}) {
  const pathname = usePathname();
  const session = authClient.useSession();
  const publicPage =
    pathname === "/login" || pathname === "/sign-in" || pathname === "/consent";
  const authDenied =
    !!session.error && [401, 403].includes(session.error.status);
  const authenticated =
    !publicPage && !session.isPending && !authDenied && !!session.data?.user;
  const identity = useQuery<{ owner_id: string; actor_id: string }>(
    "whoami",
    {},
    authenticated,
  );
  const actor = session.data?.user.id;
  const mismatch = !!identity.data && identity.data.actor_id !== actor;
  const refreshIdentity = identity.refresh;
  useEffect(() => {
    if (authenticated && mismatch) {
      clearQueryCache();
      refreshIdentity();
    }
  }, [authenticated, mismatch, refreshIdentity]);
  useEffect(() => {
    if (
      !publicPage &&
      !session.isPending &&
      (authDenied || (!session.data && !session.error))
    )
      window.location.replace("/login");
  }, [publicPage, session.isPending, session.data, session.error, authDenied]);
  if (publicPage) return <>{children}</>;
  if (!authenticated || !identity.data || mismatch)
    return (
      <main className="loading-state" role="status">
        <span>
          {identity.error ??
            session.error?.message ??
            "در حال بررسی فضای خصوصی… / Checking your private workspace…"}
        </span>
        {(identity.error || session.error) && (
          <Button
            onClick={() => {
              clearQueryCache();
              identity.refresh();
              void session.refetch();
            }}
          >
            تلاش دوباره / Retry
          </Button>
        )}
      </main>
    );
  // Background network failures keep an already verified, same-session draft
  // scope. Missing/changed authentication unmounts it and disposes its write queue.
  return (
    <TaskRowDraftProvider
      key={`${identity.data.owner_id}:${identity.data.actor_id}:${session.data!.session.id}`}
      mutate={command}
    >
      {children}
    </TaskRowDraftProvider>
  );
}
