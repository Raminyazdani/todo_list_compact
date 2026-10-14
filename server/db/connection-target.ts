/** A target's URL authority must be the target that pg actually connects to. */
export function postgresConnectionUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("POSTGRES_CONNECTION_TARGET_INVALID");
  }
  const routing = new Set([
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
    "connectionstring",
  ]);
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !url.hostname ||
    url.hostname.includes("%") ||
    url.hostname.endsWith(".") ||
    !/^(?:[a-z0-9.-]+|\[[0-9a-f:]+\])$/i.test(url.hostname) ||
    !url.pathname.slice(1) ||
    [...url.searchParams.keys()].some((key) => routing.has(key.toLowerCase()))
  )
    throw new Error("POSTGRES_CONNECTION_TARGET_INVALID");
  // pg otherwise falls back to PGPORT when the authority omits a port. Bind the
  // real connection to the same explicit default used by operator fingerprints.
  if (!url.port) url.port = "5432";
  return url;
}
