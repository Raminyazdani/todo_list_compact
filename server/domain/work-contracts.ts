import { randomUUID } from "node:crypto";
import {
  DomainError,
  type EmployerContractReportDTO,
  type Principal,
  type TimeContractIssueDTO,
  type TimeContractReportDTO,
  type TimeContractStatus,
  type TimeContractWeekDTO,
  type WorkContractPolicyDTO,
} from "../../shared/contracts";
import {
  addCalendarDays,
  instantToLocalDate,
  instantToLocalTime,
  splitIntervalByLocalDate,
  zonedLocalToInstant,
} from "../../shared/datetime";
import type { SqlClient } from "../db/database";
import { date, guard, json, object, requireScope, type Input } from "./core";
import type { Change } from "./tasks";
import { workMinutes } from "./work-log";

const ZONE = "Europe/Berlin";
const MAX_POLICIES = 12;
const MAX_ENTRIES = 10_000;
const allowedPolicyKeys = new Set([
  "id",
  "employer",
  "effective_from",
  "effective_to",
  "weekly_contract_max_minutes",
  "weekly_personal_alert_minutes",
  "weekly_average_target_minutes",
  "average_window_months",
  "monthly_reference_minutes",
  "monthly_overrides",
  "allowed_weekdays",
  "local_window_start",
  "local_window_end",
  "timesheet_due",
  "source_label",
]);

interface PolicyRow {
  policy_id: string;
  owner_id: string;
  employer: string;
  effective_from: string;
  effective_to: string | null;
  policy: Omit<
    WorkContractPolicyDTO,
    | "id"
    | "employer"
    | "effective_from"
    | "effective_to"
    | "revision"
    | "updated_at"
  >;
  revision: number;
  updated_at: string;
}
interface EntryRow extends Input {
  entry_id: string;
  employer: string;
  starts_at: string;
  ends_at: string;
}

function invalid(message: string): never {
  throw new DomainError("INVALID_INPUT", message);
}
function boundedText(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 200)
    invalid(`Invalid ${field}.`);
  return value.trim();
}
function boundedMinutes(
  value: unknown,
  field: string,
  max: number,
  allowZero = false,
): number | null {
  if (value === undefined || value === null) return null;
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < (allowZero ? 0 : 1) ||
    value > max
  )
    invalid(`Invalid ${field}.`);
  return value;
}
function localClock(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value))
    invalid(`Invalid ${field}.`);
  return value;
}
function validMonth(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/.test(value))
    invalid("month must be YYYY-MM.");
  const first = date({ value: value + "-01" }, "value");
  if (!first) invalid("Invalid month.");
  return value;
}
function shiftedMonth(month: string, offset: number): string {
  return new Date(
    Date.UTC(
      Number(month.slice(0, 4)),
      Number(month.slice(5, 7)) - 1 + offset,
      1,
    ),
  )
    .toISOString()
    .slice(0, 7);
}
function inclusiveMonths(from: string, through: string): number {
  return (
    (Number(through.slice(0, 4)) - Number(from.slice(0, 4))) * 12 +
    Number(through.slice(5, 7)) -
    Number(from.slice(5, 7)) +
    1
  );
}
function parsePolicy(
  input: Input,
): Omit<WorkContractPolicyDTO, "id" | "revision" | "updated_at"> {
  if (Object.keys(input).some((key) => !allowedPolicyKeys.has(key)))
    invalid("Unknown work contract policy field.");
  const employer = boundedText(input.employer, "employer");
  const effective_from = date(input, "effective_from");
  if (!effective_from) invalid("effective_from is required.");
  const effective_to = date(input, "effective_to");
  if (effective_to !== null && effective_to < effective_from)
    invalid("effective_to precedes effective_from.");
  const monthly_overrides: Record<string, number> = {};
  if (
    input.monthly_overrides !== undefined &&
    input.monthly_overrides !== null
  ) {
    const raw = object(input.monthly_overrides);
    if (Object.keys(raw).length > 36) invalid("Too many monthly overrides.");
    for (const [month, value] of Object.entries(raw)) {
      validMonth(month);
      monthly_overrides[month] = boundedMinutes(
        value,
        `monthly_overrides.${month}`,
        44_640,
        true,
      )!;
    }
  }
  let allowed_weekdays: number[] = [];
  if (input.allowed_weekdays !== undefined && input.allowed_weekdays !== null) {
    if (
      !Array.isArray(input.allowed_weekdays) ||
      input.allowed_weekdays.length < 1 ||
      input.allowed_weekdays.length > 7 ||
      input.allowed_weekdays.some(
        (day) => !Number.isInteger(day) || day < 1 || day > 7,
      ) ||
      new Set(input.allowed_weekdays).size !== input.allowed_weekdays.length
    )
      invalid("allowed_weekdays must contain unique ISO weekdays 1–7.");
    allowed_weekdays = [...input.allowed_weekdays].sort((a, b) => a - b);
  }
  const local_window_start = localClock(
    input.local_window_start,
    "local_window_start",
  );
  const local_window_end = localClock(
    input.local_window_end,
    "local_window_end",
  );
  if (
    (local_window_start === null) !== (local_window_end === null) ||
    (local_window_start !== null &&
      local_window_end !== null &&
      local_window_start >= local_window_end)
  )
    invalid("A local work window needs an ordered start and end.");
  let timesheet_due: WorkContractPolicyDTO["timesheet_due"] = null;
  if (input.timesheet_due !== undefined && input.timesheet_due !== null) {
    const raw = object(input.timesheet_due);
    if (
      Object.keys(raw).some((key) => key !== "kind" && key !== "day") ||
      (raw.kind !== "calendar_day" && raw.kind !== "business_day") ||
      !Number.isInteger(raw.day) ||
      (raw.day as number) < 1 ||
      (raw.day as number) > (raw.kind === "calendar_day" ? 31 : 23)
    )
      invalid("Invalid timesheet_due.");
    timesheet_due = {
      kind: raw.kind as "calendar_day" | "business_day",
      day: raw.day as number,
    };
  }
  const average_window_months = boundedMinutes(
    input.average_window_months,
    "average_window_months",
    12,
  );
  const weekly_average_target_minutes = boundedMinutes(
    input.weekly_average_target_minutes,
    "weekly_average_target_minutes",
    10_080,
  );
  if (
    (average_window_months === null) !==
    (weekly_average_target_minutes === null)
  )
    invalid("Average target and window must be set together.");
  return {
    employer,
    effective_from,
    effective_to,
    weekly_contract_max_minutes: boundedMinutes(
      input.weekly_contract_max_minutes,
      "weekly_contract_max_minutes",
      10_080,
    ),
    weekly_personal_alert_minutes: boundedMinutes(
      input.weekly_personal_alert_minutes,
      "weekly_personal_alert_minutes",
      10_080,
    ),
    weekly_average_target_minutes,
    average_window_months,
    monthly_reference_minutes: boundedMinutes(
      input.monthly_reference_minutes,
      "monthly_reference_minutes",
      44_640,
      true,
    ),
    monthly_overrides,
    allowed_weekdays,
    local_window_start,
    local_window_end,
    timesheet_due,
    source_label: boundedText(input.source_label, "source_label"),
  };
}
function policyDTO(row: PolicyRow): WorkContractPolicyDTO {
  // The production pg DATE parser returns labels; the embedded PostgreSQL
  // test adapter returns Date objects. Keep calendar dates as labels in both.
  const label = (value: string | Date) =>
    value instanceof Date ? value.toISOString().slice(0, 10) : value;
  return {
    id: row.policy_id,
    employer: row.employer,
    effective_from: label(row.effective_from),
    effective_to: row.effective_to === null ? null : label(row.effective_to),
    ...row.policy,
    revision: Number(row.revision),
    updated_at: new Date(row.updated_at).toISOString(),
  };
}
async function policyRows(tx: SqlClient, owner: string): Promise<PolicyRow[]> {
  const rows = (
    await tx.query<PolicyRow>(
      "SELECT * FROM work_contract_policies WHERE owner_id=$1 ORDER BY employer,effective_from,policy_id LIMIT $2",
      [owner, MAX_POLICIES + 1],
    )
  ).rows;
  if (rows.length > MAX_POLICIES)
    throw new DomainError(
      "INVALID_INPUT",
      "Too many work contract policy versions to assess.",
    );
  return rows;
}

export async function workContractPolicyList(
  tx: SqlClient,
  principal: Principal,
) {
  requireScope(principal, "time");
  const items = (await policyRows(tx, principal.ownerId)).map(policyDTO);
  return { items, total: items.length, next_cursor: null };
}

export async function workContractPolicyUpsert(
  tx: SqlClient,
  input: Input,
  principal: Principal,
  revision?: number,
): Promise<Change> {
  requireScope(principal, "time", true);
  const parsed = parsePolicy(input);
  const policyId = input.id;
  if (
    policyId !== undefined &&
    (typeof policyId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        policyId,
      ))
  )
    invalid("Invalid policy id.");
  const prior = policyId
    ? (
        await tx.query<PolicyRow>(
          "SELECT * FROM work_contract_policies WHERE owner_id=$1 AND policy_id=$2",
          [principal.ownerId, policyId],
        )
      ).rows[0]
    : null;
  if (policyId && !prior)
    throw new DomainError(
      "ENTITY_NOT_FOUND",
      "Work contract policy unavailable.",
      {},
      404,
    );
  if (prior) guard(prior as unknown as Input, revision);
  else if (revision !== 0)
    invalid("expectedRevision=0 is required to create a work contract policy.");
  const overlapping = (
    await tx.query<{ policy_id: string }>(
      "SELECT policy_id FROM work_contract_policies WHERE owner_id=$1 AND employer=$2 AND policy_id<>$3 AND (effective_to IS NULL OR effective_to>=$4::date) AND ($5::date IS NULL OR effective_from<=$5::date) LIMIT 1",
      [
        principal.ownerId,
        parsed.employer,
        policyId ?? "00000000-0000-0000-0000-000000000000",
        parsed.effective_from,
        parsed.effective_to,
      ],
    )
  ).rows;
  if (overlapping.length)
    throw new DomainError(
      "INVALID_INPUT",
      "Work contract policy periods for an employer may not overlap.",
    );
  if (
    !prior &&
    (await policyRows(tx, principal.ownerId)).length >= MAX_POLICIES
  )
    invalid("At most 12 work contract policy versions are supported.");
  const { employer, effective_from, effective_to, ...details } = parsed;
  const id = policyId ?? randomUUID();
  if (prior)
    await tx.query(
      "UPDATE work_contract_policies SET employer=$3,effective_from=$4,effective_to=$5,policy=$6::jsonb,revision=revision+1,updated_at=now() WHERE owner_id=$1 AND policy_id=$2",
      [
        principal.ownerId,
        id,
        employer,
        effective_from,
        effective_to,
        json(details),
      ],
    );
  else
    await tx.query(
      "INSERT INTO work_contract_policies(policy_id,owner_id,employer,effective_from,effective_to,policy) VALUES($1,$2,$3,$4,$5,$6::jsonb)",
      [
        id,
        principal.ownerId,
        employer,
        effective_from,
        effective_to,
        json(details),
      ],
    );
  const after = (
    await tx.query<PolicyRow>(
      "SELECT * FROM work_contract_policies WHERE owner_id=$1 AND policy_id=$2",
      [principal.ownerId, id],
    )
  ).rows[0];
  return {
    entityId: id,
    before: prior ? policyDTO(prior) : null,
    after: policyDTO(after),
    affected: [],
  };
}

function monday(date: string): string {
  const day = new Date(date + "T12:00:00Z").getUTCDay();
  return addCalendarDays(date, -((day + 6) % 7));
}
function isoWeekday(date: string): number {
  return ((new Date(date + "T12:00:00Z").getUTCDay() + 6) % 7) + 1;
}
function localMidnight(date: string): number {
  return Date.parse(zonedLocalToInstant(date + "T00:00", ZONE, "earlier"));
}
function covered(policy: WorkContractPolicyDTO, date: string): boolean {
  return (
    policy.effective_from <= date &&
    (policy.effective_to === null || date <= policy.effective_to)
  );
}
function issueFor(
  code: TimeContractIssueDTO["code"],
  entry: EntryRow,
  date: string,
  starts_at: string,
  ends_at: string,
): TimeContractIssueDTO {
  return {
    code,
    entry_id: entry.entry_id,
    local_date: date,
    starts_at,
    ends_at,
  };
}
function inspectionIssues(
  entry: EntryRow,
  policy: WorkContractPolicyDTO,
  from: number,
  to: number,
): TimeContractIssueDTO[] {
  const start = Math.max(from, Date.parse(entry.starts_at));
  const end = Math.min(to, Date.parse(entry.ends_at));
  if (end <= start) return [];
  const portions = splitIntervalByLocalDate(
    {
      starts_at: new Date(start).toISOString(),
      ends_at: new Date(end).toISOString(),
    },
    ZONE,
  );
  const issues: TimeContractIssueDTO[] = [];
  for (const part of portions) {
    if (!covered(policy, part.date))
      issues.push(
        issueFor(
          "OUTSIDE_EFFECTIVE_TERM",
          entry,
          part.date,
          part.starts_at,
          part.ends_at,
        ),
      );
    if (
      policy.allowed_weekdays.length &&
      !policy.allowed_weekdays.includes(isoWeekday(part.date))
    )
      issues.push(
        issueFor(
          "WEEKDAY_REVIEW",
          entry,
          part.date,
          part.starts_at,
          part.ends_at,
        ),
      );
    if (
      policy.local_window_start !== null &&
      policy.local_window_end !== null
    ) {
      const startClock = instantToLocalTime(part.starts_at, ZONE);
      const endClock =
        instantToLocalDate(part.ends_at, ZONE) === part.date
          ? instantToLocalTime(part.ends_at, ZONE)
          : "24:00";
      if (
        startClock < policy.local_window_start ||
        endClock > policy.local_window_end ||
        endClock < startClock
      )
        issues.push(
          issueFor(
            "LOCAL_WINDOW_REVIEW",
            entry,
            part.date,
            part.starts_at,
            part.ends_at,
          ),
        );
    }
  }
  return issues;
}
function status(
  minutes: number,
  threshold: number | null,
  review: boolean,
): TimeContractStatus {
  if (review) return "review";
  if (threshold === null) return "not_set";
  return minutes > threshold + 1e-7 ? "over" : "within";
}
function timeWeek(
  entries: EntryRow[],
  versions: WorkContractPolicyDTO[],
  week_start: string,
  week_end_exclusive: string,
): TimeContractWeekDTO {
  const start = localMidnight(week_start);
  const end = localMidnight(week_end_exclusive);
  const matching = entries.filter(
    (entry) =>
      Date.parse(entry.starts_at) < end && Date.parse(entry.ends_at) > start,
  );
  const minutes = matching.reduce(
    (total, entry) => total + workMinutes(entry, start, end),
    0,
  );
  const elapsed_minutes = matching.reduce(
    (total, entry) =>
      total +
      (Math.min(end, Date.parse(entry.ends_at)) -
        Math.max(start, Date.parse(entry.starts_at))) /
        60_000,
    0,
  );
  const eligible = versions.filter(
    (policy) =>
      policy.effective_from < week_end_exclusive &&
      (policy.effective_to === null || policy.effective_to >= week_start),
  );
  const policy = eligible.length === 1 ? eligible[0] : null;
  // A single known contract can still explain an entry in a wholly
  // out-of-term week, even though no cap is safe to apply in that week.
  const inspectionPolicy =
    policy ??
    (eligible.length === 0 && versions.length === 1 ? versions[0] : null);
  const legacyIssues = matching.flatMap((entry) => {
    if (entry.reporting_policy !== "legacy_wall") return [];
    const clippedStart = Math.max(start, Date.parse(entry.starts_at));
    const clippedEnd = Math.min(end, Date.parse(entry.ends_at));
    const elapsed = (clippedEnd - clippedStart) / 60_000;
    if (Math.abs(workMinutes(entry, start, end) - elapsed) <= 1e-7) return [];
    return [
      issueFor(
        "LEGACY_DURATION_REVIEW",
        entry,
        instantToLocalDate(clippedStart, ZONE),
        new Date(clippedStart).toISOString(),
        new Date(clippedEnd).toISOString(),
      ),
    ];
  });
  const issues = [
    ...(inspectionPolicy
      ? matching.flatMap((entry) =>
          inspectionIssues(entry, inspectionPolicy, start, end),
        )
      : []),
    ...legacyIssues,
  ];
  const outside = issues.filter(
    (item) => item.code === "OUTSIDE_EFFECTIVE_TERM",
  ).length;
  const review = !policy || outside > 0 || legacyIssues.length > 0;
  const contractLimit = policy?.weekly_contract_max_minutes ?? null;
  const personalLimit = policy?.weekly_personal_alert_minutes ?? null;
  const contract_state =
    !policy && eligible.length === 0
      ? "unknown"
      : status(minutes, contractLimit, review);
  const personal_state =
    !policy && eligible.length === 0
      ? "unknown"
      : status(minutes, personalLimit, review);
  return {
    week_start,
    week_end_exclusive,
    minutes,
    elapsed_minutes,
    entry_count: matching.length,
    policy_id: policy?.id ?? null,
    contract_limit_minutes: contractLimit,
    contract_remaining_minutes:
      contractLimit === null ? null : Math.max(0, contractLimit - minutes),
    contract_over_minutes:
      contractLimit === null ? 0 : Math.max(0, minutes - contractLimit),
    contract_state,
    personal_alert_minutes: personalLimit,
    personal_remaining_minutes:
      personalLimit === null ? null : Math.max(0, personalLimit - minutes),
    personal_over_minutes:
      personalLimit === null ? 0 : Math.max(0, minutes - personalLimit),
    personal_state,
    average_target_minutes: policy?.weekly_average_target_minutes ?? null,
    weekday_review_count: issues.filter(
      (item) => item.code === "WEEKDAY_REVIEW",
    ).length,
    window_review_count: issues.filter(
      (item) => item.code === "LOCAL_WINDOW_REVIEW",
    ).length,
    out_of_term_review_count: outside,
    issues,
  };
}

export async function timeContractReport(
  tx: SqlClient,
  input: Input,
  principal: Principal,
): Promise<TimeContractReportDTO> {
  requireScope(principal, "time");
  if (Object.keys(input).some((key) => key !== "month"))
    invalid("Unknown time contract report field.");
  const month = validMonth(input.month);
  const monthStart = month + "-01";
  const nextMonth = new Date(
    Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 1),
  )
    .toISOString()
    .slice(0, 10);
  const reportStart = monday(monthStart);
  const reportEnd = addCalendarDays(monday(addCalendarDays(nextMonth, -1)), 7);
  const policies = (await policyRows(tx, principal.ownerId)).map(policyDTO);
  // The same bounded read includes earlier months needed for a recorded
  // period balance. A longer history is explicitly unknown, never truncated.
  const trendStarts = policies
    .filter(
      (policy) =>
        policy.effective_from < nextMonth &&
        (policy.effective_to === null || policy.effective_to >= monthStart) &&
        inclusiveMonths(policy.effective_from.slice(0, 7), month) <= 36,
    )
    .map((policy) => policy.effective_from);
  const scanStart = [reportStart, ...trendStarts].sort()[0];
  const start = localMidnight(scanStart);
  const end = localMidnight(reportEnd);
  const entryRows = (
    await tx.query<EntryRow>(
      "SELECT entry_id,employer,starts_at,ends_at,reporting_policy,reported_minutes,legacy_metadata FROM time_entries WHERE owner_id=$1 AND archived_at IS NULL AND starts_at<$3 AND ends_at>$2 ORDER BY starts_at,entry_id LIMIT $4",
      [
        principal.ownerId,
        new Date(start).toISOString(),
        new Date(end).toISOString(),
        MAX_ENTRIES + 1,
      ],
    )
  ).rows;
  if (entryRows.length > MAX_ENTRIES)
    throw new DomainError(
      "INVALID_INPUT",
      "Work contract report exceeds 10,000 entries; totals were not assessed.",
    );
  const entries = entryRows.map((row) => ({
    ...row,
    starts_at: new Date(row.starts_at).toISOString(),
    ends_at: new Date(row.ends_at).toISOString(),
  }));
  const employers = [
    ...new Set([
      ...entries
        .filter(
          (entry) =>
            Date.parse(entry.starts_at) < end &&
            Date.parse(entry.ends_at) > localMidnight(reportStart),
        )
        .map((entry) => entry.employer),
      ...policies
        .filter(
          (policy) =>
            policy.effective_from < nextMonth &&
            (policy.effective_to === null || policy.effective_to >= monthStart),
        )
        .map((policy) => policy.employer),
    ]),
  ].sort();
  const weekStarts: string[] = [];
  for (
    let week = reportStart;
    week < reportEnd;
    week = addCalendarDays(week, 7)
  )
    weekStarts.push(week);
  const monthFrom = localMidnight(monthStart);
  const monthTo = localMidnight(nextMonth);
  const employerReports: EmployerContractReportDTO[] = employers.map(
    (employer) => {
      const employerEntries = entries.filter(
        (entry) => entry.employer === employer,
      );
      const versions = policies.filter(
        (policy) => policy.employer === employer,
      );
      const monthVersions = versions.filter(
        (policy) =>
          policy.effective_from < nextMonth &&
          (policy.effective_to === null || policy.effective_to >= monthStart),
      );
      const monthPolicy = monthVersions.length === 1 ? monthVersions[0] : null;
      const monthlyEntries = employerEntries.filter(
        (entry) =>
          Date.parse(entry.starts_at) < monthTo &&
          Date.parse(entry.ends_at) > monthFrom,
      );
      const monthlyMinutes = monthlyEntries.reduce(
        (total, entry) => total + workMinutes(entry, monthFrom, monthTo),
        0,
      );
      const partialPolicyMonth =
        monthPolicy !== null &&
        (monthPolicy.effective_from > monthStart ||
          (monthPolicy.effective_to !== null &&
            monthPolicy.effective_to < addCalendarDays(nextMonth, -1)));
      const reference =
        monthPolicy &&
        (!partialPolicyMonth ||
          Object.hasOwn(monthPolicy.monthly_overrides, month))
          ? (monthPolicy.monthly_overrides[month] ??
            monthPolicy.monthly_reference_minutes)
          : null;
      const currentMonthIncomplete =
        instantToLocalDate(Date.now(), ZONE) < nextMonth;
      let cumulative: EmployerContractReportDTO["cumulative"] = {
        from: monthPolicy?.effective_from ?? null,
        through_month: month,
        months: monthPolicy
          ? inclusiveMonths(monthPolicy.effective_from.slice(0, 7), month)
          : 0,
        reported_minutes: null,
        reference_minutes: null,
        delta_minutes: null,
        status: "unknown",
        reason: monthPolicy ? "PERIOD_TOO_LONG" : "NO_SINGLE_POLICY",
      };
      if (monthPolicy && cumulative.months <= 36) {
        const periodStart = localMidnight(monthPolicy.effective_from);
        const effectiveEnd =
          monthPolicy.effective_to === null
            ? monthTo
            : Math.min(
                monthTo,
                localMidnight(addCalendarDays(monthPolicy.effective_to, 1)),
              );
        const reported = employerEntries.reduce(
          (total, entry) =>
            total + workMinutes(entry, periodStart, effectiveEnd),
          0,
        );
        let referenceSum = 0;
        let referenceKnown = true;
        for (let index = 0; index < cumulative.months; index++) {
          const label = shiftedMonth(
            monthPolicy.effective_from.slice(0, 7),
            index,
          );
          const startOfMonth = label + "-01";
          const next = shiftedMonth(label, 1) + "-01";
          const partial =
            monthPolicy.effective_from > startOfMonth ||
            (monthPolicy.effective_to !== null &&
              monthPolicy.effective_to < addCalendarDays(next, -1));
          const monthReference =
            monthPolicy.monthly_overrides[label] ??
            (partial ? null : monthPolicy.monthly_reference_minutes);
          if (monthReference === null) referenceKnown = false;
          else referenceSum += monthReference;
        }
        const knownReference = referenceKnown ? referenceSum : null;
        cumulative = {
          from: monthPolicy.effective_from,
          through_month: month,
          months: cumulative.months,
          reported_minutes: reported,
          reference_minutes: knownReference,
          delta_minutes:
            knownReference === null ? null : reported - knownReference,
          status:
            referenceKnown && !currentMonthIncomplete
              ? "informational"
              : "unknown",
          reason: !referenceKnown
            ? "REFERENCE_MISSING_OR_PARTIAL"
            : currentMonthIncomplete
              ? "OPEN_MONTH"
              : "RECORDED_ENTRIES_ONLY",
        };
      }
      const averageMonths = monthPolicy?.average_window_months ?? null;
      const averageTarget = monthPolicy?.weekly_average_target_minutes ?? null;
      const averageStart =
        averageMonths === null
          ? null
          : shiftedMonth(month, 1 - averageMonths) + "-01";
      let average: EmployerContractReportDTO["average"] = {
        window_months: averageMonths,
        window_start: averageStart,
        window_end_exclusive: nextMonth,
        reported_minutes: null,
        recorded_average_minutes_per_week: null,
        target_minutes_per_week: averageTarget,
        status: "unknown",
        reason:
          averageMonths === null
            ? "NO_AVERAGE_POLICY"
            : "INCOMPLETE_POLICY_WINDOW",
      };
      if (
        monthPolicy &&
        averageMonths !== null &&
        averageStart !== null &&
        monthPolicy.effective_from <= averageStart &&
        (monthPolicy.effective_to === null ||
          monthPolicy.effective_to >= addCalendarDays(nextMonth, -1))
      ) {
        const from = localMidnight(averageStart);
        const reported = employerEntries.reduce(
          (total, entry) => total + workMinutes(entry, from, monthTo),
          0,
        );
        const calendarDays =
          (Date.parse(nextMonth + "T00:00:00Z") -
            Date.parse(averageStart + "T00:00:00Z")) /
          86_400_000;
        average = {
          window_months: averageMonths,
          window_start: averageStart,
          window_end_exclusive: nextMonth,
          reported_minutes: reported,
          recorded_average_minutes_per_week: (reported * 7) / calendarDays,
          target_minutes_per_week: averageTarget,
          status: currentMonthIncomplete ? "unknown" : "informational",
          reason: currentMonthIncomplete
            ? "OPEN_MONTH"
            : "RECORDED_ENTRIES_ONLY",
        };
      }
      return {
        employer,
        policy: monthPolicy,
        policies: versions,
        policy_status:
          monthVersions.length === 0
            ? "missing"
            : monthVersions.length === 1
              ? "configured"
              : "mixed",
        monthly: {
          minutes: monthlyMinutes,
          entry_count: monthlyEntries.length,
          reference_minutes: reference,
          delta_minutes: reference === null ? null : monthlyMinutes - reference,
        },
        cumulative,
        average,
        weeks: weekStarts.map((week_start) =>
          timeWeek(
            employerEntries,
            versions,
            week_start,
            addCalendarDays(week_start, 7),
          ),
        ),
      };
    },
  );
  const combined_weeks = weekStarts.map((week_start, index) => {
    const minutes = employerReports.reduce(
      (sum, employer) => sum + employer.weeks[index].minutes,
      0,
    );
    const elapsed_minutes = employerReports.reduce(
      (sum, employer) => sum + employer.weeks[index].elapsed_minutes,
      0,
    );
    return {
      week_start,
      week_end_exclusive: addCalendarDays(week_start, 7),
      minutes,
      elapsed_minutes,
      review_over_20h: elapsed_minutes > 1200 + 1e-7,
    };
  });
  return {
    month,
    timezone: ZONE,
    week_starts_on: "monday",
    reporting_basis: "entry_reporting_policy",
    data_complete: true,
    employers: employerReports,
    combined_weeks,
  };
}
