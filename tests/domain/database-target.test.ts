import { afterEach, expect, it, vi } from "vitest";
import pg from "pg";
import { postgresConnectionUrl } from "../../server/db/connection-target";

afterEach(() => vi.unstubAllEnvs());
it("binds the effective pg port instead of the ambient PGPORT", () => {
  vi.stubEnv("PGPORT", "5433");
  const url = postgresConnectionUrl("postgresql://localhost/synthetic");
  const client = new pg.Client({ connectionString: url.toString() });
  const parameters = Reflect.get(client, "connectionParameters") as {
    port: number;
    host: string;
  };
  expect(parameters.port).toBe(5432);
  expect(parameters.host).toBe("localhost");
});
it("rejects query routing overrides before constructing a connection", () => {
  for (const key of [
    "host",
    "hostaddr",
    "port",
    "database",
    "dbname",
    "user",
    "password",
    "service",
    "servicefile",
    "path",
    "connectionString",
    "HOST",
  ]) {
    expect(() =>
      postgresConnectionUrl(
        `postgresql://localhost/synthetic?${key}=synthetic-other`,
      ),
    ).toThrow("POSTGRES_CONNECTION_TARGET_INVALID");
  }
});
it("keeps ordinary hosted TLS parameters and an explicit nondefault port", () => {
  const url = postgresConnectionUrl(
    "postgresql://synthetic.invalid:5434/synthetic?sslmode=verify-full&channel_binding=require",
  );
  const client = new pg.Client({ connectionString: url.toString() });
  const parameters = Reflect.get(client, "connectionParameters") as {
    host: string;
    port: number;
    database: string;
  };
  expect(parameters.host).toBe("synthetic.invalid");
  expect(parameters.port).toBe(5434);
  expect(parameters.database).toBe("synthetic");
  expect(url.searchParams.get("channel_binding")).toBe("require");
});
it("rejects encoded or noncanonical authorities that conceal an equivalent driver host", () => {
  const literal = new pg.Client({
    connectionString: "postgresql://synthetic-production.invalid/synthetic",
  });
  const encoded = new pg.Client({
    connectionString: "postgresql://synthetic%2dproduction.invalid/synthetic",
  });
  expect(Reflect.get(encoded, "connectionParameters").host).toBe(
    Reflect.get(literal, "connectionParameters").host,
  );
  for (const host of [
    "synthetic%2dproduction.invalid",
    "synthetic-production.invalid.",
    "synthetic%2fsocket.invalid",
  ])
    expect(() =>
      postgresConnectionUrl(`postgresql://${host}/synthetic`),
    ).toThrow("POSTGRES_CONNECTION_TARGET_INVALID");
});
