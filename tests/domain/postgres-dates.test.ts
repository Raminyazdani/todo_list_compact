import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { types as postgresTypes, type Pool } from "pg";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { getDatabase, type Database } from "../../server/db/database";

let fixture: Database | undefined;
function pool() {
  if (!fixture) {
    const previous = process.env.DATABASE_URL;
    process.env.DATABASE_URL =
      "postgresql://synthetic:synthetic@localhost:5432/synthetic_date_decoder";
    try {
      fixture = getDatabase();
    } finally {
      if (previous === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previous;
    }
  }
  return Reflect.get(fixture, "pool") as Pool;
}
const parser = (format: "text" | "binary" = "text") =>
  pool().options.types!.getTypeParser(1082, format);
afterEach(() => vi.unstubAllEnvs());
afterAll(async () => {
  await fixture?.close?.();
});

describe("Domain-only PostgreSQL calendar DATE wire decoding", () => {
  it("configured_pool_preserves_calendar_day_across_positive_and_negative_timezones_without_global_parser_mutation", () => {
    const original = postgresTypes.getTypeParser(1082, "text");
    for (const zone of ["Europe/Berlin", "Asia/Tokyo", "America/Los_Angeles"]) {
      vi.stubEnv("TZ", zone);
      const before = original("2055-12-20");
      expect(before).toBeInstanceOf(Date);
      // The original scalar parser demonstrably shifts dates east of UTC after
      // JSON serialization. The configured pool must retain the calendar label.
      if (zone !== "America/Los_Angeles")
        expect(JSON.parse(JSON.stringify(before)).slice(0, 10)).toBe(
          "2055-12-19",
        );
      for (const label of [
        "2055-12-20",
        "2028-02-29",
        "1999-12-31",
        "0001-01-01",
        "9999-12-31",
      ]) {
        const value = parser()(label);
        expect(typeof value).toBe("string");
        expect(JSON.parse(JSON.stringify({ due_date: value })).due_date).toBe(
          label,
        );
      }
    }
    expect(postgresTypes.getTypeParser(1082, "text")).toBe(original);
  });
  it("binary_signed_days_since2000_preserve_pre_epoch_dates_leap_day_and_exact_boundaries", () => {
    const decode = parser("binary");
    for (const [days, label] of [
      [0, "2000-01-01"],
      [-1, "1999-12-31"],
      [59, "2000-02-29"],
      [60, "2000-03-01"],
      [-730119, "0001-01-01"],
      [2921939, "9999-12-31"],
    ] as const) {
      const bytes = Buffer.alloc(4);
      bytes.writeInt32BE(days);
      expect(decode(bytes)).toBe(label);
    }
  });
  it("nonfinite_out_of_domain_dates_invalid_leap_days_and_malformed_binary_are_rejected", () => {
    for (const label of [
      "",
      "infinity",
      "-infinity",
      "2055-12-20T00:00:00",
      "2027-02-29",
      "2055-13-01",
      "0000-01-01",
      "10000-01-01",
      "0001-01-01 BC",
    ])
      expect(() => parser()(label)).toThrow("DOMAIN_DATABASE_DATE_INVALID");
    for (const days of [2147483647, -2147483648, -730120, 2921940]) {
      const bytes = Buffer.alloc(4);
      bytes.writeInt32BE(days);
      expect(() => parser("binary")(bytes)).toThrow(/DOMAIN_DATABASE_DATE_/);
    }
    for (const bytes of [Buffer.alloc(0), Buffer.alloc(3), Buffer.alloc(5)])
      expect(() => parser("binary")(bytes)).toThrow(
        "DOMAIN_DATABASE_DATE_INVALID",
      );
  });
  it("only_scalar_DATE_is_overridden_timestamps_auth_integers_json_and_DATE_arrays_keep_existing_parsers", () => {
    for (const oid of [20, 23, 1114, 1184, 1182, 1700, 3802])
      for (const format of ["text", "binary"] as const)
        expect(pool().options.types!.getTypeParser(oid, format)).toBe(
          postgresTypes.getTypeParser(oid, format),
        );
    expect(
      pool().options.types!.getTypeParser(20, "text")("1791911964293"),
    ).toBe("1791911964293");
    expect(pool().options.max).toBe(5);
  });
});

describe.skipIf(process.env.TEST_POSTGRES !== "1")(
  "Real staging PostgreSQL DATE roundtrips under independent host timezones",
  () => {
    it("native_driver_task_read_start_only_plan_source_import_export_and_fresh_engine_restore_preserve_the_same_calendar_day", async () => {
      expect(Boolean(process.env.DATABASE_URL)).toBe(true);
      const probe = fileURLToPath(
        new URL("./fixtures/postgres-date-probe.ts", import.meta.url),
      );
      for (const zone of [
        "Europe/Berlin",
        "Asia/Tokyo",
        "America/Los_Angeles",
      ]) {
        const result = await new Promise<{
          exitCode: number | null;
          stdout: string;
          stderr: string;
        }>((resolve, reject) => {
          const child = spawn(process.execPath, ["--import", "tsx", probe], {
            cwd: fileURLToPath(new URL("../../", import.meta.url)),
            env: { ...process.env, TZ: zone, TEST_POSTGRES: "1" },
            windowsHide: true,
            timeout: 90000,
            stdio: ["ignore", "pipe", "pipe"],
          });
          let stdout = "",
            stderr = "";
          child.stdout.on("data", (data: Buffer) => {
            stdout += data.toString();
          });
          child.stderr.on("data", (data: Buffer) => {
            stderr += data.toString();
          });
          child.on("error", () =>
            reject(new Error("POSTGRES_DATE_SUBPROCESS_FAILED")),
          );
          child.on("close", (exitCode) =>
            resolve({ exitCode, stdout, stderr }),
          );
        });
        // The probe emits only these fixed public aggregates and redacted failures.
        expect(result.stderr).toBe("");
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe("POSTGRES_DATE_PROBE_PASS\n");
      }
    }, 280000);
  },
);
