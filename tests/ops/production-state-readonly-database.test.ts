import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import { PGlite } from "@electric-sql/pglite";
import type { Database } from "../../server/db/database";
import { nativeReadOnlyDatabase } from "../../scripts/ops/verify-production-state";

const pool = vi.hoisted(() => ({
  config: undefined as Record<string, unknown> | undefined,
  connect: vi.fn(),
  on: vi.fn(),
  end: vi.fn(),
}));
vi.mock("pg", async (importOriginal) => ({
  ...(await importOriginal<typeof import("pg")>()),
  Pool: vi.fn(function (config: Record<string, unknown>) {
    pool.config = config;
    return { connect: pool.connect, on: pool.on, end: pool.end };
  }),
}));

type Row = Record<string, unknown>;
type ClientQuery = (
  sql: string,
  params?: unknown[],
) => Promise<{ rows: Row[]; rowCount: number }>;

describe("operator native read-only transactions with an isolated PostgreSQL engine", () => {
  let engine: PGlite, database: Database;
  let query: Mock<ClientQuery>, release: Mock;
  const fixtureUrl = new URL("postgresql://synthetic.neon.invalid/fixture");
  fixtureUrl.username = "synthetic";
  fixtureUrl.password = "synthetic";
  fixtureUrl.searchParams.set("options", "-c default_transaction_read_only=on");
  const url = fixtureUrl.toString();

  beforeAll(async () => {
    engine = new PGlite();
    await engine.exec(`
      CREATE TABLE synthetic_verifier_rows(value integer NOT NULL);
      CREATE FUNCTION synthetic_verifier_write() RETURNS integer LANGUAGE plpgsql AS $$
      BEGIN
        INSERT INTO synthetic_verifier_rows(value) VALUES(1);
        RETURN 1;
      END;
      $$;
    `);
  });
  beforeEach(async () => {
    vi.clearAllMocks();
    await engine.exec("TRUNCATE synthetic_verifier_rows");
    query = vi.fn(async (sql, params = []) => {
      const result = await engine.query<Row>(sql, params);
      // Match node-postgres SELECT rowCount; PGlite reports affectedRows as zero.
      return { rows: result.rows, rowCount: result.rows.length };
    });
    release = vi.fn();
    pool.connect.mockResolvedValue({ query, release });
    pool.end.mockResolvedValue(undefined);
    database = nativeReadOnlyDatabase(url);
  });
  afterEach(async () => {
    await database.close?.();
    // Also reset the isolated engine when a simulated broken rollback discarded
    // its mock lease. This never connects to any hosted database.
    await engine.exec("ROLLBACK");
  });
  afterAll(async () => {
    await engine.close();
  });

  it("omits unsupported startup options while retaining exact routing, TLS and all pool budgets", async () => {
    expect(pool.config).not.toHaveProperty("options");
    expect(pool.config).toMatchObject({
      max: 1,
      connectionTimeoutMillis: 8000,
      idleTimeoutMillis: 10000,
      query_timeout: 15000,
      ssl: { rejectUnauthorized: true },
    });
    const target = new URL(String(pool.config?.connectionString));
    expect(target.hostname).toBe("synthetic.neon.invalid");
    expect(target.port).toBe("5432");
    expect(target.pathname).toBe("/fixture");
    expect(target.searchParams.get("sslmode")).toBe("verify-full");
    expect(target.searchParams.has("options")).toBe(false);
    expect(pool.connect).not.toHaveBeenCalled();
    await database.close?.();
    const localUrl = new URL("postgresql://localhost:5432/fixture");
    localUrl.username = "synthetic";
    localUrl.password = "synthetic";
    database = nativeReadOnlyDatabase(localUrl.toString());
    expect(pool.config?.ssl).toBeUndefined();
    expect(pool.config).not.toHaveProperty("options");
  });

  it("rejects commands, multi-statements and domain transactions before acquiring a connection", async () => {
    for (const sql of [
      "INSERT INTO synthetic_verifier_rows VALUES(1)",
      "SELECT 1; SELECT 2",
      "BEGIN READ WRITE",
    ])
      await expect(database.query(sql)).rejects.toThrow(
        "READ_ONLY_SQL_REQUIRED",
      );
    await expect(
      database.transaction("synthetic-owner", async () => null),
    ).rejects.toThrow("READ_ONLY_SQL_REQUIRED");
    expect(pool.connect).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });

  it("sets database-enforced read-only isolation and local timeout before SELECT and starts a new snapshot for each read", async () => {
    const settings = await database.query(
      "SELECT current_setting('transaction_read_only') mode,current_setting('transaction_isolation') isolation,current_setting('statement_timeout') timeout",
    );
    expect(settings.rows).toEqual([
      { mode: "on", isolation: "repeatable read", timeout: "15s" },
    ]);
    expect(query.mock.calls.map(([sql]) => sql)).toEqual([
      "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
      "SET LOCAL statement_timeout = '15000ms'",
      expect.stringContaining("SELECT current_setting"),
      "COMMIT",
    ]);
    expect(release).toHaveBeenCalledExactlyOnceWith();
    await engine.query("INSERT INTO synthetic_verifier_rows VALUES($1)", [7]);
    const current = await database.query(
      "SELECT value FROM synthetic_verifier_rows",
    );
    expect(current.rows).toEqual([{ value: 7 }]);
    expect(pool.connect).toHaveBeenCalledTimes(2);
    expect(
      query.mock.calls.filter(([sql]) => sql.startsWith("BEGIN")),
    ).toHaveLength(2);
    expect(release).toHaveBeenCalledTimes(2);
    expect(
      await database.query("SELECT $1::integer AS exact_parameter", [9]),
    ).toMatchObject({
      rows: [{ exact_parameter: 9 }],
      rowCount: 1,
    });
  });

  it("blocks a SELECT function's actual SQL write, rolls back and leaves the next admitted read usable", async () => {
    await expect(
      database.query("SELECT synthetic_verifier_write()"),
    ).rejects.toMatchObject({ code: "25006" });
    expect(query.mock.calls.at(-1)).toEqual(["ROLLBACK"]);
    expect(release).toHaveBeenCalledExactlyOnceWith();
    expect(
      (
        await database.query(
          "SELECT count(*)::integer AS count FROM synthetic_verifier_rows",
        )
      ).rows,
    ).toEqual([{ count: 0 }]);
  });

  it.each([
    "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
    "SET LOCAL statement_timeout = '15000ms'",
    "SELECT 1 AS value",
    "COMMIT",
  ])(
    "rolls back and releases on %s failure without replacing the original error",
    async (failedSql) => {
      const failure = new Error("synthetic verifier query failure");
      const actual = query.getMockImplementation()!;
      query.mockImplementation(async (sql, params) => {
        if (sql === failedSql) throw failure;
        return actual(sql, params);
      });
      await expect(database.query("SELECT 1 AS value")).rejects.toBe(failure);
      expect(query.mock.calls.at(-1)).toEqual(["ROLLBACK"]);
      expect(release).toHaveBeenCalledExactlyOnceWith();
      if (failedSql.startsWith("BEGIN") || failedSql.startsWith("SET"))
        expect(
          query.mock.calls.some(([sql]) => sql === "SELECT 1 AS value"),
        ).toBe(false);
    },
  );

  it("discards the lease when rollback fails and preserves the first error", async () => {
    const failure = new Error("synthetic original failure");
    const actual = query.getMockImplementation()!;
    query.mockImplementation(async (sql, params) => {
      if (sql === "SELECT 1 AS value") throw failure;
      if (sql === "ROLLBACK") throw new Error("synthetic rollback failure");
      return actual(sql, params);
    });
    await expect(database.query("SELECT 1 AS value")).rejects.toBe(failure);
    expect(release).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("propagates acquisition failure without attempting SQL or releasing an unacquired lease", async () => {
    const failure = new Error("synthetic acquisition failure");
    pool.connect.mockRejectedValue(failure);
    await expect(database.query("SELECT 1")).rejects.toBe(failure);
    expect(query).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
  });
});
