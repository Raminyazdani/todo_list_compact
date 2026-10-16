import { describe, expect, it } from "vitest";
import type { EventDTO, TimeEntryDTO } from "../../shared/contracts";
import {
  entryLocal,
  intervalUnionMinutes,
  localPoint,
  monthDays,
  snappedMinute,
  workConflicts,
  workSegments,
} from "../../features/work-planner-model";
import { splitTimeImport } from "../../features/time-transfer-model";
import { upcomingCalendarEnd } from "../../features/calendar-dates";

function entry(id: string, start: string, end: string): TimeEntryDTO {
  return {
    entry_id: id,
    employer: "Jena",
    starts_at: start,
    ends_at: end,
    description: "Synthetic",
    task_id: null,
    revision: 1,
    minutes: (Date.parse(end) - Date.parse(start)) / 60000,
  };
}
function event(id: string, start: string, end: string): EventDTO {
  return {
    event_id: id,
    title: "Synthetic event",
    starts_at: start,
    ends_at: end,
    timezone: "Europe/Berlin",
    all_day: false,
    provider: "google_calendar",
    task_id: null,
    notes: "",
    recurrence_rule: null,
    revision: 1,
  };
}

describe("Work Planner native timeline and backup semantics", () => {
  it("keeps the live upcoming horizon valid through spring gaps and local DST weeks", () => {
    expect(upcomingCalendarEnd("2026-03-22T01:30:00Z")).toBe(
      "2026-03-29T01:30:00.000Z",
    );
    expect(upcomingCalendarEnd("2026-10-24T10:00:00Z")).toBe(
      "2026-10-31T11:00:00.000Z",
    );
  });
  it("renders every calendar day including leap month and snaps/clamps quarter hours", () => {
    expect(monthDays("2028-02")).toHaveLength(29);
    expect(monthDays("2026-10").at(-1)).toBe("2026-10-31");
    expect(snappedMinute(-50, 0, 960)).toBe(0);
    expect(snappedMinute(9600, 0, 960)).toBe(1440);
    expect(snappedMinute(101, 0, 960)).toBe(150);
    expect(localPoint("2026-10-31", 1440)).toBe("2026-11-01T00:00");
  });
  it("splits overnight intervals at the actual local month boundary", () => {
    const value = entry(
      "overnight",
      "2026-10-31T22:30:00Z",
      "2026-11-01T01:30:00Z",
    );
    expect(
      workSegments(value).map((part) => [
        part.date,
        part.startMinute,
        part.endMinute,
      ]),
    ).toEqual([
      ["2026-10-31", 1410, 1440],
      ["2026-11-01", 0, 150],
    ]);
    expect(entryLocal(value).end_next_day).toBe(true);
  });
  it("retains DST wall positions without replacing the recorded elapsed duration", () => {
    const value = entry("fold", "2026-10-24T23:30:00Z", "2026-10-25T02:30:00Z");
    expect(value.minutes).toBe(180);
    expect(
      workSegments(value).map((part) => [
        part.startMinute,
        part.endMinute,
        part.offset_label,
      ]),
    ).toEqual([
      [90, 180, "+02:00"],
      [120, 210, "+01:00"],
    ]);
    expect(entryLocal(value)).toMatchObject({
      date: "2026-10-25",
      start: "01:30",
      end: "03:30",
      end_next_day: false,
    });
    const repeated = workSegments(
      entry("backward-fold", "2026-10-25T00:45:00Z", "2026-10-25T01:15:00Z"),
    );
    expect(
      repeated.map((part) => [part.startMinute, part.endMinute, part.minutes]),
    ).toEqual([
      [165, 180, 15],
      [120, 135, 15],
    ]);
  });
  it("reports union conflict minutes independently from recorded totals", () => {
    const rows = [
      entry("a", "2026-10-01T08:00:00Z", "2026-10-01T11:00:00Z"),
      entry("b", "2026-10-01T09:00:00Z", "2026-10-01T12:00:00Z"),
      entry("c", "2026-10-01T10:00:00Z", "2026-10-01T11:30:00Z"),
    ];
    const allDay = {
      ...event("busy", "2026-09-30T22:00:00Z", "2026-10-01T22:00:00Z"),
      all_day: true,
    };
    const result = workConflicts(
      rows,
      [
        allDay,
        { ...allDay, event_id: "free", busy: false },
        { ...allDay, event_id: "declined", self_declined: true },
      ],
      "2026-10-01T00:00:00Z",
      "2026-10-02T00:00:00Z",
    );
    expect(result.workMinutes).toBe(150);
    expect(result.eventMinutes).toBe(240);
    expect(result.minutes).toBe(240);
    expect(
      result.intersections.filter((value) => value.kind === "event"),
    ).toHaveLength(3);
    expect(rows.reduce((sum, row) => sum + row.minutes, 0)).toBe(450);
    expect(
      intervalUnionMinutes([
        { starts_at: "2026-10-01T09:00:00Z", ends_at: "2026-10-01T10:00:00Z" },
        { starts_at: "2026-10-01T09:30:00Z", ends_at: "2026-10-01T11:00:00Z" },
      ]),
    ).toBe(120);
  });
  it("round-trips arbitrary whole history into bounded batches with drafts and provenance", () => {
    const entries = Array.from({ length: 2101 }, (_, index) => ({
      entry_id: `entry-${index}`,
      employer: "Jena",
      starts_at: "2026-10-25T00:00:00Z",
      ends_at: "2026-10-25T02:00:00Z",
      reporting_policy: "legacy_wall",
      reported_minutes: 60,
      legacy_metadata: {
        original_id: String(index),
        description: "فارسی\nEnglish",
      },
    }));
    const drafts = [
      {
        draft_id: "draft-1",
        employer: "Seewiesen",
        date: "2026-10-25",
        start: "09:00",
        end: "",
        end_next_day: false,
        description: "Incomplete",
        timezone: "Europe/Berlin",
      },
    ];
    const batches = splitTimeImport({
      format: "ramin-life-os-time/1",
      timezone: "Europe/Berlin",
      entries,
      drafts,
    });
    expect(batches).toHaveLength(3);
    expect(batches.flatMap((batch) => batch.entries)).toEqual(entries);
    expect(batches.flatMap((batch) => batch.drafts)).toEqual(drafts);
    expect(
      batches.every(
        (batch) =>
          (batch.entries as unknown[]).length +
            (batch.drafts as unknown[]).length <=
          1000,
      ),
    ).toBe(true);
  });
  it("bounds UTF-8 payload bytes and preserves legacy incomplete entries", () => {
    const items = Array.from({ length: 100 }, (_, index) => ({
      id: String(index),
      jobId: "jena",
      date: "2026-10-01",
      start: "",
      end: "",
      tasks: "س".repeat(10000),
    }));
    const batches = splitTimeImport({ version: 1, entries: items });
    expect(batches.length).toBeGreaterThan(1);
    expect(batches.flatMap((batch) => batch.entries)).toEqual(items);
    expect(
      batches.every(
        (batch) =>
          new TextEncoder().encode(JSON.stringify(batch)).length <= 1_800_000,
      ),
    ).toBe(true);
    expect(() => splitTimeImport({ format: "unknown", entries: [] })).toThrow();
  });
});
