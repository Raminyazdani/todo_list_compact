import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { Pool } from "pg";
import { getDatabase, type Database } from "../../server/db/database";

// Injected acquisition failures only: these tests make no network connections.
describe("Fixed domain pool acquisition diagnostics", () => {
  let db: Database, pool: Pool;
  let originalConnect: unknown, originalQuery: unknown;
  beforeAll(() => {
    const previous = process.env.DATABASE_URL;
    process.env.DATABASE_URL =
      "postgresql://synthetic:synthetic@localhost:5432/synthetic_diagnostics";
    try {
      db = getDatabase();
    } finally {
      if (previous === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previous;
    }
    pool = Reflect.get(db, "pool") as Pool;
    originalConnect = pool.connect;
    originalQuery = pool.query;
  });
  afterEach(() => {
    Reflect.set(pool, "connect", originalConnect);
    Reflect.set(pool, "query", originalQuery);
    vi.restoreAllMocks();
  });
  afterAll(async () => {
    await db.close?.();
  });

  it.each([
    ["timeout exceeded when trying to connect", "pool_wait_timeout"],
    [
      "Connection terminated due to connection timeout",
      "network_connect_timeout",
    ],
    [
      "synthetic confidential SQL SELECT credentials FROM synthetic_private",
      "other",
    ],
  ])(
    "classifies_only_exact_acquisition_messages_and_rethrows_original_error_%s",
    async (message, classification) => {
      const cause = new Error(
        "synthetic private URL https://synthetic.invalid/?token=synthetic-secret",
      );
      const error = Object.assign(new Error(message, { cause }), {
        code: "SYNTHETIC_SECRET_CODE",
        owner: "synthetic-private-owner",
      });
      const log = vi
        .spyOn(console, "error")
        .mockImplementation(() => undefined);
      Reflect.set(
        pool,
        "connect",
        vi.fn(async () => {
          throw error;
        }),
      );
      await expect(
        db.readTransaction!("synthetic-private-owner", async () => null),
      ).rejects.toBe(error);
      expect(log.mock.calls).toEqual([
        [
          "DOMAIN_DATABASE_ACQUIRE_FAILED",
          {
            classification,
            total: 0,
            idle: 0,
            waiting: 0,
          },
        ],
      ]);
      const encoded = JSON.stringify(log.mock.calls);
      for (const secret of [
        "synthetic-secret",
        "credentials",
        "synthetic_private",
        "SYNTHETIC_SECRET_CODE",
        "synthetic-private-owner",
        "stack",
        "cause",
      ])
        expect(encoded).not.toContain(secret);
    },
  );

  it("direct_query_reports_known_acquisition_timeout_without_misclassifying_SQL_errors", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const timeout = new Error("timeout exceeded when trying to connect");
    Reflect.set(
      pool,
      "query",
      vi.fn(async () => {
        throw timeout;
      }),
    );
    await expect(
      db.query("SELECT synthetic_private_value", ["synthetic-private-owner"]),
    ).rejects.toBe(timeout);
    expect(log.mock.calls).toEqual([
      [
        "DOMAIN_DATABASE_ACQUIRE_FAILED",
        {
          classification: "pool_wait_timeout",
          total: 0,
          idle: 0,
          waiting: 0,
        },
      ],
    ]);
    log.mockClear();
    const sqlError = Object.assign(
      new Error("synthetic confidential SQL query failure"),
      { code: "SYNTHETIC_SQL_PRIVATE" },
    );
    Reflect.set(
      pool,
      "query",
      vi.fn(async () => {
        throw sqlError;
      }),
    );
    await expect(db.query("SELECT synthetic_private_value")).rejects.toBe(
      sqlError,
    );
    expect(log).not.toHaveBeenCalled();
  });

  it("callback_failure_keeps_original_rollback_release_and_read_only_lock_semantics", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const query = vi.fn(async () => ({ rows: [], rowCount: 0 }));
    const release = vi.fn();
    Reflect.set(
      pool,
      "connect",
      vi.fn(async () => ({ query, release })),
    );
    const failure = new Error("synthetic callback failure");
    await expect(
      db.readTransaction!("synthetic-owner", async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(query.mock.calls).toEqual([
      ["BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"],
      [
        "SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))",
        ["synthetic-owner"],
      ],
      ["ROLLBACK"],
    ]);
    expect(release).toHaveBeenCalledExactlyOnceWith();
    expect(log).not.toHaveBeenCalled();
  });
});
