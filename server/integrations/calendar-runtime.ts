import { createHash } from "node:crypto";
import { getAuth } from "../auth/config";
import { getAuthPool } from "../auth/db";
import {
  DomainError,
  type Principal,
  type EventDTO,
} from "../../shared/contracts";
import { GoogleReadClient, normalizeGoogleEvent } from "./google";
import { fetchIcalFeed } from "./ical-fetch";
import { parseIcal } from "./calendar";

type SourceState = {
  provider: string;
  status: string;
  last_success_at: string | null;
  error: string | null;
};
type Calendar = {
  calendar_id: string;
  title: string;
  provider: string;
  writable: false;
};
const READ_SCOPE = "https://www.googleapis.com/auth/calendar.readonly";
function configuration() {
  return {
    google:
      !!process.env.GOOGLE_CLIENT_ID && !!process.env.GOOGLE_CLIENT_SECRET,
    ical:
      !!process.env.GOOGLE_ICAL_URL && !!process.env.GOOGLE_ICAL_ALLOWED_HOSTS,
  };
}
async function client(principal: Principal) {
  if (!configuration().google) return null;
  // The principal is already verified by the canonical API. Select the exact owner's account,
  // then let Better Auth decrypt/refresh it; caller-supplied provider tokens are never accepted.
  const row = await getAuthPool().query<{
    id: string;
    user_id: string;
    scope: string | null;
  }>(
    `SELECT a.id,a."userId" AS user_id,a.scope FROM account a JOIN "user" u ON u.id=a."userId"
     WHERE a."providerId"='google' AND lower(u.email)=$1 AND ($2::text IS NULL OR u.id=$2) ORDER BY a."createdAt" LIMIT 1`,
    [
      process.env.OWNER_EMAIL?.toLowerCase(),
      principal.channel === "system" ? null : principal.actorId,
    ],
  );
  const account = row.rows[0];
  if (!account) return null;
  if (!account.scope?.split(/[ ,]+/).includes(READ_SCOPE))
    throw new DomainError(
      "INSUFFICIENT_PERMISSIONS",
      "مجوز خواندن تقویم Google موجود نیست؛ اتصال را دوباره تأیید کنید.",
      {},
      403,
    );
  try {
    const token = await getAuth().api.getAccessToken({
      body: { accountId: account.id, userId: account.user_id },
    });
    if (!token.scopes.includes(READ_SCOPE)) throw new Error("MISSING_SCOPE");
    return new GoogleReadClient(token.accessToken);
  } catch {
    throw new DomainError(
      "UNSUPPORTED_OPERATION",
      "مجوز Google منقضی یا لغو شده است؛ دوباره متصل شوید.",
      {},
      503,
    );
  }
}
async function record(principal: Principal, provider: string, ok: boolean) {
  await getAuthPool().query(
    `INSERT INTO integration_sync_state(owner_id,provider,last_success_at,status,error)
    VALUES($1,$2,CASE WHEN $3 THEN now() ELSE NULL END,$4,$5)
    ON CONFLICT(owner_id,provider) DO UPDATE SET last_success_at=CASE WHEN $3 THEN now() ELSE integration_sync_state.last_success_at END,status=$4,error=$5`,
    [
      principal.ownerId,
      provider,
      ok,
      ok ? "connected" : "error",
      ok ? null : "SOURCE_READ_FAILED",
    ],
  );
}
async function monitoredClient(principal: Principal) {
  if (!configuration().google) return null;
  try {
    const google = await client(principal);
    if (!google)
      await getAuthPool().query(
        `INSERT INTO integration_sync_state(owner_id,provider,status,error) VALUES($1,'google_calendar','awaiting_grant',NULL)
      ON CONFLICT(owner_id,provider) DO UPDATE SET status='awaiting_grant',error=NULL`,
        [principal.ownerId],
      );
    return google;
  } catch (error) {
    await record(principal, "google_calendar", false);
    throw error;
  }
}
export async function externalCalendarStatus(
  principal: Principal,
): Promise<SourceState[]> {
  const configured = configuration();
  const base = ["google_calendar", "ical"].map(
    (provider) =>
      ({
        provider,
        status: (provider === "ical" ? configured.ical : configured.google)
          ? "awaiting_grant"
          : "not_configured",
        last_success_at: null,
        error: null,
      }) as SourceState,
  );
  if (!configured.google && !configured.ical) return base;
  const states = await getAuthPool().query<SourceState>(
    "SELECT provider,status,last_success_at,error FROM integration_sync_state WHERE owner_id=$1",
    [principal.ownerId],
  );
  return base.map((state) => ({
    ...state,
    ...(state.status !== "not_configured"
      ? states.rows.find((row) => row.provider === state.provider)
      : {}),
  }));
}
export async function externalCalendarList(
  principal: Principal,
): Promise<Calendar[]> {
  const result: Calendar[] = [];
  const google = await monitoredClient(principal);
  if (google) {
    try {
      let token: string | undefined;
      for (let page = 0; page < 10; page++) {
        const data = await google.listCalendars(token);
        for (const row of (data.items ?? []) as Array<
          Record<string, unknown>
        >) {
          if (typeof row.id === "string")
            result.push({
              calendar_id: row.id,
              title: String(row.summary ?? "Google Calendar"),
              provider: "google_calendar",
              writable: false,
            });
        }
        token =
          typeof data.nextPageToken === "string"
            ? data.nextPageToken
            : undefined;
        if (!token) break;
        if (page === 9)
          throw new DomainError(
            "INVALID_INPUT",
            "تعداد تقویم‌ها از حد ایمن بیشتر است.",
          );
      }
      await record(principal, "google_calendar", true);
    } catch (error) {
      await record(principal, "google_calendar", false);
      throw error;
    }
  }
  if (configuration().ical)
    result.push({
      calendar_id: "ical",
      title: "Private iCalendar",
      provider: "ical",
      writable: false,
    });
  return result;
}
function externalId(calendar: string, uid: string) {
  return (
    "EXT_" +
    createHash("sha256")
      .update(calendar + "\0" + uid)
      .digest("hex")
      .slice(0, 40)
  );
}
export async function externalCalendarEvents(
  principal: Principal,
  from: string,
  to: string,
  calendarId?: string,
): Promise<(EventDTO & { occurrence_key: string; source_read_only: true })[]> {
  const result: (EventDTO & {
    occurrence_key: string;
    source_read_only: true;
  })[] = [];
  const google =
    calendarId === "ical" || calendarId === "local"
      ? null
      : await monitoredClient(principal);
  if (google) {
    try {
      const calendars = (await externalCalendarList(principal)).filter(
        (row) =>
          row.provider === "google_calendar" &&
          (!calendarId || row.calendar_id === calendarId),
      );
      if (calendarId && !calendars.length)
        throw new DomainError(
          "ENTITY_NOT_FOUND",
          "تقویم در حساب متصل پیدا نشد.",
          {},
          404,
        );
      for (const calendar of calendars) {
        let token: string | undefined;
        for (let page = 0; page < 20; page++) {
          const data = await google.calendarEvents(
            calendar.calendar_id,
            from,
            to,
            token,
          );
          for (const row of (data.items ?? []) as Array<
            Record<string, unknown>
          >) {
            const event = normalizeGoogleEvent(row);
            if (!event || typeof event.external_uid !== "string") continue;
            const event_id = externalId(
              calendar.calendar_id,
              event.external_uid,
            );
            result.push({
              ...event,
              event_id,
              occurrence_key: event_id + ":" + event.starts_at,
              task_id: null,
              recurrence_rule: null,
              revision: 1,
              source_read_only: true,
            });
            if (result.length > 5000)
              throw new DomainError(
                "INVALID_INPUT",
                "بازهٔ کوتاه‌تری برای تقویم انتخاب کنید.",
              );
          }
          token =
            typeof data.nextPageToken === "string"
              ? data.nextPageToken
              : undefined;
          if (!token) break;
          if (page === 19)
            throw new DomainError(
              "INVALID_INPUT",
              "بازهٔ کوتاه‌تری برای تقویم انتخاب کنید.",
            );
        }
      }
      await record(principal, "google_calendar", true);
    } catch (error) {
      await record(principal, "google_calendar", false);
      throw error;
    }
  }
  if (configuration().ical && (!calendarId || calendarId === "ical")) {
    try {
      const feed = await fetchIcalFeed(process.env.GOOGLE_ICAL_URL!, {
        allowedHosts: process.env
          .GOOGLE_ICAL_ALLOWED_HOSTS!.split(",")
          .map((value) => value.trim())
          .filter(Boolean),
      });
      for (const event of parseIcal(feed, from, to)) {
        result.push({
          ...event,
          event_id: externalId("ical", event.uid),
          task_id: null,
          recurrence_rule: null,
          revision: 1,
          source_read_only: true,
        });
      }
      await record(principal, "ical", true);
    } catch {
      await record(principal, "ical", false);
      throw new DomainError(
        "UNSUPPORTED_OPERATION",
        "خوراک خصوصی تقویم خوانده نشد؛ اتصال و محدودهٔ مجاز میزبان را بررسی کنید.",
        {},
        503,
      );
    }
  }
  return result.sort((a, b) => a.starts_at.localeCompare(b.starts_at));
}
