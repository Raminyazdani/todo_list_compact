import { Pool, types as postgresTypes, type CustomTypesConfig } from "pg";

/** Auth timestamps/counts must be numeric; never round an unsafe database int8. */
function authInteger(value: string | Buffer): number {
  let integer: bigint;
  if (Buffer.isBuffer(value)) {
    if (value.length !== 8)
      throw new TypeError("AUTH_DATABASE_INTEGER_INVALID");
    integer = value.readBigInt64BE();
  } else {
    if (!/^-?\d+$/.test(value))
      throw new TypeError("AUTH_DATABASE_INTEGER_INVALID");
    integer = BigInt(value);
  }
  if (
    integer > BigInt(Number.MAX_SAFE_INTEGER) ||
    integer < BigInt(Number.MIN_SAFE_INTEGER)
  )
    throw new RangeError("AUTH_DATABASE_INTEGER_UNSAFE");
  return Number(integer);
}
const authTypes: CustomTypesConfig = {
  getTypeParser(oid, format) {
    return oid === 20 ? authInteger : postgresTypes.getTypeParser(oid, format);
  },
};

let pool: Pool | undefined;
export function getAuthPool() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_UNAVAILABLE");
  const databaseUrl = new URL(process.env.DATABASE_URL);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(
    databaseUrl.hostname,
  );
  if (!local) databaseUrl.searchParams.set("sslmode", "verify-full");
  if (!pool) {
    pool = new Pool({
      connectionString: databaseUrl.toString(),
      ssl: local ? undefined : { rejectUnauthorized: true },
      max: 3,
      idleTimeoutMillis: 20000,
      connectionTimeoutMillis: 10000,
      types: authTypes,
    });
    pool.on("error", () => console.error("AUTH_DATABASE_CONNECTION_FAILED"));
  }
  return pool;
}
