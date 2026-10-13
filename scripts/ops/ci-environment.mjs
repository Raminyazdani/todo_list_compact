import { writeFile } from "node:fs/promises";
import { join, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { randomBytes } from "node:crypto";
export async function createCiEnvironment({
  directory = process.cwd(),
  ci = process.env.CI,
} = {}) {
  if (ci !== "true" || !isAbsolute(directory))
    throw new Error(
      "Synthetic environment generation is restricted to explicit CI and an absolute workspace.",
    );
  const values = {
    DATABASE_URL:
      "postgresql://postgres:synthetic-ci-password@localhost:5432/lifeos_test",
    OWNER_EMAIL: "owner@example.test",
    OWNER_ID: "synthetic-ci-owner",
    BETTER_AUTH_URL: "http://localhost:3000",
    BETTER_AUTH_SECRET: randomBytes(48).toString("base64url"),
    TOKEN_ENCRYPTION_KEY: randomBytes(32).toString("base64url"),
  };
  await writeFile(
    join(directory, ".env.local"),
    Object.entries(values)
      .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
      .join("\n") + "\n",
    { mode: 0o600, flag: "wx" },
  );
  return { configured: true, synthetic_only: true };
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url)
  createCiEnvironment()
    .then(() =>
      console.log(
        "Isolated synthetic CI environment configured; no secret values emitted",
      ),
    )
    .catch(() => {
      console.error(
        "CI environment generation stopped; existing environment files retained.",
      );
      process.exitCode = 1;
    });
