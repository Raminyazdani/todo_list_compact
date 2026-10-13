import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { types as postgresTypes, type Pool } from "pg";
import { getAuthPool } from "../../server/auth/db";

let fixturePool: Pool | undefined;
function pool() {
  vi.stubEnv(
    "DATABASE_URL",
    "postgresql://synthetic:synthetic@localhost:5432/synthetic_auth_decoder",
  );
  fixturePool ??= getAuthPool();
  return fixturePool;
}
const parser = (format: "text" | "binary" = "text") =>
  pool().options.types!.getTypeParser(20, format);
afterEach(() => {
  vi.unstubAllEnvs();
});
afterAll(async () => {
  await fixturePool?.end();
});

describe("Auth-only PostgreSQL integer decoding protects real rate windows", () => {
  it("configured_auth_pool_reads_millisecond_timestamps_and_exact_safe_int8_edges_as_numbers", () => {
    const decode = parser(),
      timestamp = 1791911964293;
    expect(decode(String(timestamp))).toBe(timestamp);
    expect(
      Math.ceil((decode(String(timestamp)) + 10000 - (timestamp + 250)) / 1000),
    ).toBe(10);
    for (const integer of [
      0,
      -1,
      2147483648,
      -2147483649,
      Number.MAX_SAFE_INTEGER,
      Number.MIN_SAFE_INTEGER,
    ]) {
      const decoded = decode(String(integer));
      expect(typeof decoded).toBe("number");
      expect(decoded).toBe(integer);
    }
  });
  it("unsafe_postgres_int8_values_are_rejected_without_numeric_rounding", () => {
    const decode = parser();
    for (const value of [
      "9007199254740992",
      "9007199254740993",
      "-9007199254740992",
      "-9007199254740993",
      "9223372036854775807",
      "-9223372036854775808",
    ])
      expect(() => decode(value)).toThrow("AUTH_DATABASE_INTEGER_UNSAFE");
  });
  it("binary_int8_uses_the_same_exact_safety_boundary", () => {
    const decode = parser("binary");
    for (const value of [
      1791911964293n,
      2147483648n,
      -2147483649n,
      9007199254740991n,
      -9007199254740991n,
    ]) {
      const bytes = Buffer.alloc(8);
      bytes.writeBigInt64BE(value);
      expect(decode(bytes)).toBe(Number(value));
    }
    const unsafe = Buffer.alloc(8);
    unsafe.writeBigInt64BE(9223372036854775807n);
    expect(() => decode(unsafe)).toThrow("AUTH_DATABASE_INTEGER_UNSAFE");
    expect(() => decode(Buffer.alloc(7))).toThrow(
      "AUTH_DATABASE_INTEGER_INVALID",
    );
  });
  it("invalid_wire_numbers_cannot_become_NaN_floats_or_infinity", () => {
    const decode = parser();
    for (const value of ["", " ", "1.5", "1e3", "Infinity", "NaN", "+1", "1x"])
      expect(() => decode(value)).toThrow("AUTH_DATABASE_INTEGER_INVALID");
  });
  it("domain_and_other_postgres_type_parsers_remain_unmodified", () => {
    const original = postgresTypes.getTypeParser(20, "text");
    parser();
    expect(postgresTypes.getTypeParser(20, "text")).toBe(original);
    expect(original("1791911964293")).toBe("1791911964293");
    for (const oid of [23, 1700, 3802])
      expect(pool().options.types!.getTypeParser(oid, "text")).toBe(
        postgresTypes.getTypeParser(oid, "text"),
      );
    expect(pool().options.max).toBe(3);
    expect(pool().options.connectionTimeoutMillis).toBe(10000);
  });
});

describe.skipIf(
  !process.env.TEST_CREDENTIALS_PATH ||
    process.env.RUN_AUTH_RATE_LIMIT_TEST !== "1",
)("Actual local staging sign-in rolling rate limit", () => {
  it("three_signins_succeed_fourth_is429_with_valid_retry_after_then_expiry_allows_signin", async () => {
    const origin = process.env.HTTP_TEST_ORIGIN || "http://localhost:3000",
      target = new URL(origin);
    expect(target.protocol).toBe("http:");
    expect(["localhost", "127.0.0.1", "[::1]"].includes(target.hostname)).toBe(
      true,
    );
    expect(target.origin).toBe(origin);
    const credentials = JSON.parse(
      await readFile(process.env.TEST_CREDENTIALS_PATH!, "utf8"),
    ) as { email: string; password: string };
    expect(
      typeof credentials.email === "string" &&
        typeof credentials.password === "string",
    ).toBe(true);
    const signIn = () =>
      fetch(origin + "/api/auth/sign-in/email", {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: origin },
        body: JSON.stringify({
          email: credentials.email,
          password: credentials.password,
        }),
        signal: AbortSignal.timeout(15000),
      });
    // This test runs sequentially after other HTTP checks. Respect the complete
    // existing 10-second rolling window rather than resetting rate-limit rows.
    await new Promise((resolve) => setTimeout(resolve, 10250));
    const accepted: number[] = [];
    for (let index = 0; index < 3; index++) {
      const response = await signIn();
      accepted.push(response.status);
      await response.arrayBuffer();
    }
    expect(accepted).toEqual([200, 200, 200]);
    const denied = await signIn();
    expect(denied.status).toBe(429);
    const advertised =
      denied.headers.get("X-Retry-After") ?? denied.headers.get("Retry-After");
    expect(advertised !== null && /^\d+$/.test(advertised)).toBe(true);
    const seconds = Number(advertised);
    expect(Number.isSafeInteger(seconds) && seconds >= 1 && seconds <= 10).toBe(
      true,
    );
    await denied.arrayBuffer();
    await new Promise((resolve) => setTimeout(resolve, seconds * 1000 + 250));
    const afterExpiry = await signIn();
    expect(afterExpiry.status).toBe(200);
    await afterExpiry.arrayBuffer();
  }, 60000);
});
