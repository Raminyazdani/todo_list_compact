import { describe, expect, it, vi } from "vitest";
import * as RRulePackage from "rrule";
import {
  expandRecurrence,
  type RecurringEvent,
} from "../../server/integrations/calendar";
import {
  instantToLocalDateTime,
  zonedLocalToInstant,
} from "../../shared/datetime";
const RRule = (RRulePackage.RRule ??
  Reflect.get(RRulePackage, "default")?.RRule) as typeof RRulePackage.RRule;
const event = (
  recurrence_rule: string,
  starts_at = "2026-01-07T08:27:45Z",
  timezone = "Europe/Berlin",
): RecurringEvent => ({
  event_id: "synthetic-seek",
  title: "Synthetic recurrence",
  starts_at,
  ends_at: new Date(Date.parse(starts_at) + 3600000).toISOString(),
  timezone,
  all_day: false,
  recurrence_rule,
});
/** Independent oracle retains the original DTSTART and lets upstream rrule scan. */
function anchoredStarts(item: RecurringEvent, from: string, to: string) {
  const lower = Date.parse(from) - 3600000 - 86400000,
    upper = Date.parse(to) + 86400000,
    options = RRule.parseString(item.recurrence_rule!),
    rule = new RRule({
      ...options,
      dtstart: new Date(
        instantToLocalDateTime(item.starts_at, item.timezone) + "Z",
      ),
    }),
    starts: string[] = [];
  for (const date of rule.between(new Date(lower), new Date(upper), true)) {
    const local = date.toISOString().slice(0, 19);
    if (
      item.recurrence_exceptions?.some(
        (value) => value === local || value === local.slice(0, 10),
      )
    )
      continue;
    let actual: string;
    try {
      actual = zonedLocalToInstant(local, item.timezone, "earlier");
    } catch {
      continue;
    }
    if (
      Date.parse(actual) < Date.parse(to) &&
      Date.parse(actual) + 3600000 > Date.parse(from)
    )
      starts.push(actual);
  }
  return starts;
}
describe("Phase-preserving recurrence range seeking", () => {
  it.each([
    [
      "FREQ=DAILY;INTERVAL=3;BYDAY=MO,WE,FR",
      "2026-01-07T08:27:45Z",
      "2048-03-01T00:00Z",
      "2048-04-01T00:00Z",
    ],
    [
      "FREQ=WEEKLY;INTERVAL=3;BYDAY=MO,TH;WKST=SU",
      "2026-01-07T08:27:45Z",
      "2048-03-01T00:00Z",
      "2048-04-01T00:00Z",
    ],
    [
      "FREQ=WEEKLY;INTERVAL=2",
      "2026-01-07T08:27:45Z",
      "2048-10-01T00:00Z",
      "2048-11-01T00:00Z",
    ],
    [
      "FREQ=MONTHLY;INTERVAL=2",
      "2026-01-31T08:27:45Z",
      "2048-01-01T00:00Z",
      "2049-01-01T00:00Z",
    ],
    [
      "FREQ=MONTHLY;INTERVAL=2;BYMONTHDAY=-1",
      "2026-01-31T08:27:45Z",
      "2048-01-01T00:00Z",
      "2049-01-01T00:00Z",
    ],
    [
      "FREQ=MONTHLY;BYDAY=-1SU",
      "2026-01-07T08:27:45Z",
      "2048-01-01T00:00Z",
      "2049-01-01T00:00Z",
    ],
    [
      "FREQ=MONTHLY;INTERVAL=2;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1",
      "2026-01-07T08:27:45Z",
      "2048-01-01T00:00Z",
      "2049-01-01T00:00Z",
    ],
    [
      "FREQ=YEARLY;INTERVAL=3;BYMONTH=5;BYDAY=2MO",
      "2026-01-07T08:27:45Z",
      "2400-01-01T00:00Z",
      "2401-01-01T00:00Z",
    ],
    [
      "FREQ=YEARLY",
      "2024-02-29T08:27:45Z",
      "2400-01-01T00:00Z",
      "2401-01-01T00:00Z",
    ],
    [
      "FREQ=YEARLY;INTERVAL=3;BYWEEKNO=1;BYDAY=MO",
      "2026-06-07T08:27:45Z",
      "2400-01-01T00:00Z",
      "2401-01-01T00:00Z",
    ],
  ])(
    "preserves original phase and normalized defaults for %s",
    (rule, start, from, to) => {
      const item = event(rule, start);
      expect(
        expandRecurrence(item, from, to).map((row) => row.starts_at),
      ).toEqual(anchoredStarts(item, from, to));
    },
  );
  it("does not reset COUNT when the requested window follows the final original occurrence", () => {
    const item = event("FREQ=DAILY;COUNT=10000");
    expect(
      expandRecurrence(item, "2055-01-01T00:00Z", "2055-02-01T00:00Z"),
    ).toEqual([]);
  });
  it("retains DST gaps, explicit exception dates and exact wall-clock seconds after seeking", () => {
    const item = {
      ...event("FREQ=DAILY", "2026-03-27T01:30:45Z"),
      recurrence_exceptions: ["2048-03-30"],
    };
    expect(
      expandRecurrence(item, "2048-03-25T00:00Z", "2048-04-02T00:00Z").map(
        (row) => row.starts_at,
      ),
    ).toEqual(anchoredStarts(item, "2048-03-25T00:00Z", "2048-04-02T00:00Z"));
  });
  it.each([
    "FREQ=DAILY",
    "FREQ=WEEKLY;BYDAY=TU,TH",
    "FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1",
  ])("does not enumerate thousands of past years for %s", (rule) => {
    const between = vi.spyOn(RRule.prototype, "between");
    try {
      const rows = expandRecurrence(
        event(rule),
        "7311-12-01T00:00Z",
        "7312-01-01T00:00Z",
      );
      expect(rows.length).toBeGreaterThan(0);
      expect(
        (
          between.mock.contexts[0] as RRulePackage.RRule
        ).options.dtstart.getUTCFullYear(),
      ).toBeGreaterThanOrEqual(7311);
      expect(rows.every((row) => row.starts_at.startsWith("7311-12-"))).toBe(
        true,
      );
    } finally {
      between.mockRestore();
    }
  });
  it("expired UNTIL stops before iteration without extending a finite series", () => {
    const between = vi.spyOn(RRule.prototype, "between");
    try {
      expect(
        expandRecurrence(
          event("FREQ=DAILY;UNTIL=20300101T090000Z"),
          "7311-12-01T00:00Z",
          "7312-01-01T00:00Z",
        ),
      ).toEqual([]);
      expect(between).not.toHaveBeenCalled();
    } finally {
      between.mockRestore();
    }
  });
});
