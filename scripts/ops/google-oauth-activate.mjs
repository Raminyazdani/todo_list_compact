import { createHash, randomUUID } from "node:crypto";
import { open } from "node:fs/promises";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { isAbsolute } from "node:path";
import { EXPECTED_PROJECT } from "./provision-secrets.mjs";
import {
  admitPrivatePath,
  replacePinnedContents,
  verifyLinkedProject,
  withPrivateFile,
} from "./private-paths.mjs";

export const GOOGLE_OAUTH_CALLBACK =
  "https://ramin-life-os.vercel.app/api/auth/callback/google";
const FORMAT = "ramin-life-os-google-oauth-activation/1";
const KEYS = ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"];
const TARGET = Object.freeze({
  ...EXPECTED_PROJECT,
  environment: "production",
  callback: GOOGLE_OAUTH_CALLBACK,
});
const fingerprint = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
function invalid(message) {
  throw new Error(message);
}

/** Consume CLI output privately. Credential values travel only over stdin. */
export async function runGoogleOAuthVercel({ bin, args, secret, cwd }) {
  return new Promise((resolve, reject) => {
    const environment = {
      ...process.env,
      VERCEL_PROJECT_ID: EXPECTED_PROJECT.projectId,
      VERCEL_ORG_ID: EXPECTED_PROJECT.orgId,
    };
    delete environment.GOOGLE_CLIENT_ID;
    delete environment.GOOGLE_CLIENT_SECRET;
    const child = spawn(process.execPath, [bin, ...args], {
      cwd,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: environment,
    });
    let stdout = "",
      oversized = false,
      finished = false;
    const fail = () => {
      if (!finished) {
        finished = true;
        reject(
          new Error(
            "Vercel request failed; private activation journal retained.",
          ),
        );
      }
    };
    child.stdout.on("data", (chunk) => {
      // Add output is deliberately discarded, even if a CLI version echoes input.
      if (secret !== undefined) return;
      if (stdout.length + chunk.length > 2_000_000) {
        oversized = true;
        child.kill();
        return;
      }
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", () => {});
    child.stdin.on("error", () => {});
    child.on("error", fail);
    child.on("close", (code) => {
      if (finished) return;
      finished = true;
      if (oversized || code !== 0)
        reject(
          new Error(
            "Vercel request failed; private activation journal retained.",
          ),
        );
      else resolve({ stdout });
    });
    child.stdin.end(secret === undefined ? "" : secret + "\n");
  });
}
function parseGoogleWebCredentials(raw) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    invalid("Invalid Google credential JSON.");
  }
  if (
    !data ||
    typeof data !== "object" ||
    Array.isArray(data) ||
    !data.web ||
    data.installed
  )
    invalid("A Google Web OAuth credential file is required.");
  const web = data.web;
  if (
    !web ||
    typeof web !== "object" ||
    Array.isArray(web) ||
    typeof web.client_id !== "string" ||
    !/^[A-Za-z0-9._-]{5,500}\.apps\.googleusercontent\.com$/.test(
      web.client_id,
    ) ||
    typeof web.client_secret !== "string" ||
    web.client_secret.length < 8 ||
    web.client_secret.length > 1000 ||
    /[\s\u0000-\u001f\u007f]/.test(web.client_secret) ||
    web.auth_uri !== "https://accounts.google.com/o/oauth2/auth" ||
    web.token_uri !== "https://oauth2.googleapis.com/token" ||
    !Array.isArray(web.redirect_uris) ||
    !web.redirect_uris.includes(GOOGLE_OAUTH_CALLBACK)
  )
    invalid(
      "Google Web OAuth client, endpoints or exact production callback are invalid.",
    );
  return {
    GOOGLE_CLIENT_ID: web.client_id,
    GOOGLE_CLIENT_SECRET: web.client_secret,
  };
}
function environmentMetadata(output) {
  let body;
  try {
    body = JSON.parse(output);
  } catch {
    invalid("Vercel environment inventory is not valid JSON.");
  }
  if (!body || !Array.isArray(body.envs) || body.envs.length > 10000)
    invalid("Vercel environment inventory is invalid.");
  const selected = new Map();
  for (const item of body.envs) {
    if (!item || typeof item !== "object" || typeof item.key !== "string")
      invalid("Vercel environment inventory is invalid.");
    if (!KEYS.includes(item.key)) continue;
    const targets =
      typeof item.target === "string" ? [item.target] : item.target;
    if (
      !Array.isArray(targets) ||
      targets.some((target) => typeof target !== "string")
    )
      invalid("Vercel environment target metadata is invalid.");
    if (!targets.includes("production")) continue;
    if (selected.has(item.key) || item.gitBranch || targets.length !== 1)
      invalid("Google OAuth environment target is ambiguous.");
    selected.set(item.key, {
      key: item.key,
      type: item.type ?? null,
      target: ["production"],
      createdAt: item.createdAt ?? null,
      updatedAt: item.updatedAt ?? null,
      configurationId: item.configurationId ?? null,
    });
  }
  return selected;
}
function validateJournal(value, values) {
  if (
    !value ||
    value.format !== FORMAT ||
    fingerprint(value.target) !== fingerprint(TARGET) ||
    value.credentials_hash !== fingerprint(values) ||
    fingerprint(value.values) !== fingerprint(values) ||
    !value.steps ||
    Object.keys(value.steps).length !== KEYS.length ||
    KEYS.some(
      (key) =>
        !value.steps[key] ||
        !["pending", "sending", "confirmed", "uncertain"].includes(
          value.steps[key].state,
        ) ||
        typeof value.steps[key].intent_id !== "string",
    )
  )
    invalid("Activation journal target or credential identity mismatch.");
  return value;
}
/** Fixed project and Production only. Never overwrites an existing unknown value. */
export async function activateGoogleOAuth(
  input,
  {
    repositoryRoot = process.cwd(),
    run = runGoogleOAuthVercel,
    report = console.log,
  } = {},
) {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).some(
      (key) => !["credentialPath", "journalPath", "vercelBin"].includes(key),
    )
  )
    invalid(
      "Google OAuth activation only admits the fixed Production target and three operator paths.",
    );
  const { credentialPath, journalPath, vercelBin } = input;
  if (!credentialPath || !journalPath || !vercelBin || !isAbsolute(vercelBin))
    invalid(
      "Absolute credential, private journal and Vercel executable paths are required.",
    );
  const repository = await verifyLinkedProject(
      repositoryRoot,
      EXPECTED_PROJECT,
    ),
    options = { repositoryRoot: repository, mustExist: true };
  const credentials = await admitPrivatePath(credentialPath, options),
    journal = await admitPrivatePath(journalPath, {
      repositoryRoot: repository,
    });
  if (credentials.toLowerCase() === journal.toLowerCase())
    invalid(
      "Activation journal must be separate from the original credential file.",
    );
  const values = await withPrivateFile(
    credentials,
    async (file) => {
      if ((await file.stat()).size > 100_000)
        invalid("Google credential file exceeds its bound.");
      return parseGoogleWebCredentials(await file.readFile("utf8"));
    },
    options,
  );
  let created;
  try {
    created = await open(journal, "wx", 0o600);
  } catch (error) {
    if (error.code !== "EEXIST")
      invalid("Private activation journal could not be created.");
  }
  if (created) {
    try {
      await admitPrivatePath(journal, options);
      await replacePinnedContents(
        created,
        JSON.stringify(
          {
            format: FORMAT,
            target: TARGET,
            credentials_hash: fingerprint(values),
            values,
            created_at: new Date().toISOString(),
            steps: Object.fromEntries(
              KEYS.map((key) => [
                key,
                { state: "pending", intent_id: randomUUID(), attempts: 0 },
              ]),
            ),
          },
          null,
          2,
        ) + "\n",
      );
    } finally {
      await created.close();
    }
  }
  return withPrivateFile(
    journal,
    async (file) => {
      let saved;
      try {
        saved = JSON.parse(await file.readFile("utf8"));
      } catch {
        invalid(
          "Private activation journal is invalid; no hosted value changed.",
        );
      }
      const state = validateJournal(saved, values),
        persist = () =>
          replacePinnedContents(file, JSON.stringify(state, null, 2) + "\n");
      async function request(args, secret) {
        await verifyLinkedProject(repository, EXPECTED_PROJECT);
        return run({
          bin: vercelBin,
          args: [...args, "--scope", EXPECTED_PROJECT.orgId],
          ...(secret === undefined ? {} : { secret }),
          cwd: repository,
        });
      }
      async function inventory() {
        const response = await request([
          "env",
          "ls",
          "production",
          "--format",
          "json",
        ]);
        return environmentMetadata(response?.stdout);
      }
      let remote = await inventory();
      // Check BOTH keys before the first add; a mixed unknown configuration must
      // not leave one newly configured variable and one unrelated existing value.
      for (const key of KEYS) {
        const step = state.steps[key],
          existing = remote.get(key);
        if (!existing) continue;
        if (
          step.state !== "confirmed" ||
          step.metadata_hash !== fingerprint(existing)
        ) {
          step.state =
            step.state === "sending" || step.state === "uncertain"
              ? "uncertain"
              : step.state;
          state.status = "blocked_existing_or_uncertain";
          await persist();
          invalid(
            "Existing or uncertain Google OAuth variable requires verification; no value was overwritten.",
          );
        }
      }
      for (const key of KEYS) {
        const step = state.steps[key];
        if (step.state === "confirmed") {
          if (!remote.has(key))
            invalid(
              "A previously confirmed Google OAuth variable is missing; review before retrying.",
            );
          continue;
        }
        if (remote.has(key)) {
          state.status = "blocked_existing_or_uncertain";
          await persist();
          invalid(
            "Existing or uncertain Google OAuth variable requires verification; no value was overwritten.",
          );
        }
        // The intent and exact retry value are durable before every hosted write.
        step.state = "sending";
        step.attempts++;
        step.started_at = new Date().toISOString();
        state.status = "activating";
        await persist();
        try {
          await request(
            ["env", "add", key, "production", "--sensitive", "--yes"],
            state.values[key],
          );
        } catch {
          step.state = "uncertain";
          state.status = "uncertain";
          await persist();
          // A definitive absence allows a later explicit retry with the SAME
          // journal values. A present hidden value is never assumed to be ours.
          try {
            remote = await inventory();
            if (!remote.has(key)) {
              step.state = "pending";
              await persist();
            }
          } catch {
            /* Keep the uncertain journal. */
          }
          invalid(
            "Google OAuth activation stopped; private journal retained for verification or exact-value retry.",
          );
        }
        remote = await inventory();
        const acknowledged = remote.get(key);
        if (
          !acknowledged ||
          !["sensitive", "secret"].includes(acknowledged.type)
        ) {
          step.state = "uncertain";
          state.status = "uncertain";
          await persist();
          invalid(
            "Google OAuth environment acknowledgement is incomplete; no overwrite will be attempted.",
          );
        }
        step.state = "confirmed";
        step.metadata_hash = fingerprint(acknowledged);
        step.confirmed_at = new Date().toISOString();
        await persist();
        report(`production: ${key} configured securely`);
      }
      state.status = "configured";
      await persist();
      return {
        configured: true,
        environment: "production",
        count: KEYS.length,
        values_retained: true,
      };
    },
    options,
  );
}
if (
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  const [operation, credentialPath, journalPath, vercelBin, ...extra] =
    process.argv.slice(2);
  if (operation !== "--activate-google-oauth" || extra.length) {
    console.error(
      "Explicit Google OAuth activation, credential path, private journal and CLI path are required.",
    );
    process.exitCode = 1;
  } else
    activateGoogleOAuth({ credentialPath, journalPath, vercelBin }).catch(
      () => {
        console.error(
          "Google OAuth activation stopped safely; private journal retained and no secret values printed.",
        );
        process.exitCode = 1;
      },
    );
}
