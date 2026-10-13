import { writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
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
  ".env.local",
  Object.entries(values)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join("\n"),
  { mode: 0o600 },
);
console.log(
  "Isolated synthetic CI environment configured; no secret values emitted",
);
