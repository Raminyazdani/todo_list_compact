import { randomBytes, randomUUID } from "node:crypto";
import { parseEnv } from "node:util";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import {
  admitPrivatePath,
  replacePinnedContents,
  verifyLinkedProject,
  withPrivateFile,
} from "./private-paths.mjs";
export const EXPECTED_PROJECT = Object.freeze({
  projectId: "prj_wfYC3rSJccmvT6hZ21QbGtRqdkfs",
  orgId: "team_t1y5QDuakPdppOy5zuZLx66A",
  name: "ramin-life-os",
});
async function runVercel({ bin, args, secret, cwd }) {
  const code = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bin, ...args], {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    child.stdout.on("data", () => {});
    child.stderr.on("data", () => {});
    child.on("error", reject);
    child.on("close", resolve);
    child.stdin.end(secret + "\n");
  });
  if (code !== 0)
    throw new Error(
      "Vercel environment update failed; private values retained for retry.",
    );
}
export async function provisionSecrets(
  { environment, envPath, vercelBin, ownerEmail, productionOrigin },
  {
    repositoryRoot = process.cwd(),
    run = runVercel,
    report = console.log,
  } = {},
) {
  if (
    !["production", "development", "preview"].includes(environment) ||
    !envPath ||
    !vercelBin ||
    !ownerEmail
  )
    throw new Error(
      "Explicit environment, private file, CLI and owner identity required.",
    );
  if (environment === "production") {
    const url = new URL(productionOrigin);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/"
    )
      throw new Error("Production requires a verified HTTPS origin.");
    productionOrigin = url.origin;
  }
  const repository = await verifyLinkedProject(
    repositoryRoot,
    EXPECTED_PROJECT,
  );
  const options = {
    repositoryRoot: repository,
    allowIgnoredLocal: environment !== "production",
    mustExist: true,
  };
  const path = await admitPrivatePath(envPath, options);
  const values = await withPrivateFile(
    path,
    async (file) => {
      const existing = parseEnv(await file.readFile("utf8"));
      if (
        existing.OWNER_EMAIL &&
        existing.OWNER_EMAIL.toLowerCase() !== ownerEmail.toLowerCase()
      )
        throw new Error("Environment owner identity mismatch.");
      const generated = {
        BETTER_AUTH_SECRET:
          existing.BETTER_AUTH_SECRET || randomBytes(48).toString("base64url"),
        OWNER_EMAIL: existing.OWNER_EMAIL || ownerEmail,
        OWNER_ID: existing.OWNER_ID || randomUUID(),
        TOKEN_ENCRYPTION_KEY:
          existing.TOKEN_ENCRYPTION_KEY ||
          randomBytes(32).toString("base64url"),
        BACKUP_ENCRYPTION_KEY:
          existing.BACKUP_ENCRYPTION_KEY ||
          randomBytes(32).toString("base64url"),
        CRON_SECRET:
          existing.CRON_SECRET || randomBytes(32).toString("base64url"),
        ...(environment === "production"
          ? { BETTER_AUTH_URL: productionOrigin }
          : {}),
      };
      const merged = {
        ...existing,
        ...generated,
        ...(environment === "development"
          ? { BETTER_AUTH_URL: "http://localhost:3000" }
          : {}),
      };
      await verifyLinkedProject(repository, EXPECTED_PROJECT);
      await replacePinnedContents(
        file,
        Object.entries(merged)
          .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
          .join("\n") + "\n",
      );
      return generated;
    },
    options,
  );
  for (const [key, secret] of Object.entries(values)) {
    await verifyLinkedProject(repository, EXPECTED_PROJECT);
    await run({
      bin: vercelBin,
      args: [
        "env",
        "add",
        key,
        environment,
        "--force",
        "--scope",
        "ramin-yazdanis-projects",
      ],
      secret,
      cwd: repository,
    });
    report(`${environment}: ${key} configured`);
  }
  return {
    configured: true,
    count: Object.keys(values).length,
    values_retained: true,
  };
}
if (
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  const [environment, envPath, vercelBin, ownerEmail, productionOrigin] =
    process.argv.slice(2);
  provisionSecrets({
    environment,
    envPath,
    vercelBin,
    ownerEmail,
    productionOrigin,
  }).catch(() => {
    console.error(
      "Environment provisioning stopped; private values retained and no secret values printed.",
    );
    process.exitCode = 1;
  });
}
