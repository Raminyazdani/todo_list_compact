import { spawn } from "node:child_process";
import { access, readFile, realpath } from "node:fs/promises";
import { delimiter, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPOSITORY = fileURLToPath(new URL("../../", import.meta.url));
const PROJECT = "ramin-life-os";
const TEAM = "ramin-yazdanis-projects";
const GITHUB_REPOSITORY = "Raminyazdani/todo_list_compact";

function reject(code) {
  throw new Error(code);
}

/** Pure admission checks are exported for synthetic tests; no provider is invoked here. */
export function validateReleaseContext({
  env,
  head,
  dirty,
  origin,
  link,
  remoteProject,
  remoteTeam,
}) {
  if (remoteProject === null || remoteTeam === null)
    reject("REDEPLOY_REMOTE_IDENTITY_UNAVAILABLE");
  if (env.E2E_REDEPLOY_ALLOWED !== "1")
    reject("REDEPLOY_EXPLICIT_PERMISSION_REQUIRED");
  if (
    !/^[a-f0-9]{40}$/.test(env.E2E_REDEPLOY_EXPECTED_SHA ?? "") ||
    head !== env.E2E_REDEPLOY_EXPECTED_SHA
  )
    reject("REDEPLOY_SHA_MISMATCH");
  if (dirty.trim()) reject("REDEPLOY_DIRTY_CHECKOUT");
  const remote = origin.trim().replace(/\.git$/, "");
  if (
    ![
      "https://github.com/" + GITHUB_REPOSITORY,
      "git@github.com:" + GITHUB_REPOSITORY,
      "ssh://git@github.com/" + GITHUB_REPOSITORY,
    ].includes(remote)
  )
    reject("REDEPLOY_REPOSITORY_MISMATCH");
  if (
    !/^prj_[A-Za-z0-9]+$/.test(env.E2E_REDEPLOY_EXPECTED_PROJECT_ID ?? "") ||
    !/^team_[A-Za-z0-9]+$/.test(env.E2E_REDEPLOY_EXPECTED_TEAM_ID ?? "")
  )
    reject("REDEPLOY_EXACT_PROVIDER_IDS_REQUIRED");
  if (!/^dpl_[A-Za-z0-9]+$/.test(env.E2E_REDEPLOY_INITIAL_DEPLOYMENT_ID ?? ""))
    reject("REDEPLOY_EXISTING_PRODUCTION_REQUIRED");
  if (
    link.projectId !== env.E2E_REDEPLOY_EXPECTED_PROJECT_ID ||
    link.orgId !== env.E2E_REDEPLOY_EXPECTED_TEAM_ID ||
    (link.projectName && link.projectName !== PROJECT)
  )
    reject("REDEPLOY_LOCAL_PROJECT_MISMATCH");
  if (
    remoteProject &&
    (remoteProject.id !== link.projectId ||
      remoteProject.accountId !== link.orgId ||
      remoteProject.name !== PROJECT ||
      remoteProject.link?.type !== "github" ||
      remoteProject.link?.org !== "Raminyazdani" ||
      remoteProject.link?.repo !== "todo_list_compact")
  )
    reject("REDEPLOY_REMOTE_PROJECT_MISMATCH");
  if (remoteTeam && (remoteTeam.id !== link.orgId || remoteTeam.slug !== TEAM))
    reject("REDEPLOY_REMOTE_TEAM_MISMATCH");
}

export function validateDeploymentProof(deployment, env) {
  if (
    !/^dpl_[A-Za-z0-9]+$/.test(deployment.id ?? "") ||
    deployment.readyState !== "READY" ||
    deployment.target !== "production" ||
    deployment.projectId !== env.E2E_REDEPLOY_EXPECTED_PROJECT_ID ||
    deployment.ownerId !== env.E2E_REDEPLOY_EXPECTED_TEAM_ID ||
    deployment.name !== PROJECT
  )
    reject("REDEPLOY_READY_PRODUCTION_NOT_VERIFIED");
}

function run(executable, args, cwd, env, timeoutMs = 60_000) {
  return new Promise((resolveResult, rejectResult) => {
    const child = spawn(executable, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
    });
    let stdout = "",
      totalBytes = 0,
      stopped = false;
    const fail = (code) => {
      if (stopped) return;
      stopped = true;
      child.kill();
      rejectResult(new Error(code));
    };
    const timer = setTimeout(() => fail("REDEPLOY_COMMAND_TIMEOUT"), timeoutMs);
    child.stdout.on("data", (chunk) => {
      totalBytes += chunk.length;
      if (totalBytes > 2 * 1024 * 1024) fail("REDEPLOY_OUTPUT_LIMIT");
      else stdout += chunk.toString();
    });
    // Provider stderr can contain paths, credentials or private build details. Never relay it.
    child.stderr.on("data", (chunk) => {
      totalBytes += chunk.length;
      if (totalBytes > 2 * 1024 * 1024) fail("REDEPLOY_OUTPUT_LIMIT");
    });
    child.once("error", () => {
      clearTimeout(timer);
      fail("REDEPLOY_COMMAND_UNAVAILABLE");
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (stopped) return;
      if (code !== 0) return rejectResult(new Error("REDEPLOY_COMMAND_FAILED"));
      resolveResult(stdout.trim());
    });
  });
}

async function resolveVercelEntry(env) {
  // Run the package's JS bin with Node, avoiding Windows shell/.cmd interpolation.
  const packageDirectories = [join(REPOSITORY, "node_modules", "vercel")];
  for (const pathDirectory of (env.PATH ?? env.Path ?? "").split(delimiter)) {
    if (pathDirectory)
      packageDirectories.push(join(pathDirectory, "node_modules", "vercel"));
  }
  if (env.E2E_REDEPLOY_VERCEL_PACKAGE)
    packageDirectories.unshift(resolve(env.E2E_REDEPLOY_VERCEL_PACKAGE));
  for (const packageDirectory of packageDirectories) {
    try {
      const packageJson = JSON.parse(
        await readFile(join(packageDirectory, "package.json"), "utf8"),
      );
      if (
        packageJson.name !== "vercel" ||
        typeof packageJson.bin?.vercel !== "string"
      )
        continue;
      const entry = await realpath(
        join(packageDirectory, packageJson.bin.vercel),
      );
      await access(entry);
      return entry;
    } catch {
      /* Try the next installed package location; never install or authenticate implicitly. */
    }
  }
  reject("REDEPLOY_VERCEL_CLI_NOT_INSTALLED");
}

export async function main(env = process.env) {
  if (env.E2E_REDEPLOY_ALLOWED !== "1")
    reject("REDEPLOY_EXPLICIT_PERMISSION_REQUIRED");
  if (process.argv.slice(2).length) reject("REDEPLOY_ARGUMENTS_NOT_ALLOWED");
  const head = await run("git", ["rev-parse", "HEAD"], REPOSITORY, env);
  const dirty = await run(
    "git",
    ["status", "--porcelain", "--untracked-files=all"],
    REPOSITORY,
    env,
  );
  const origin = await run(
    "git",
    ["remote", "get-url", "origin"],
    REPOSITORY,
    env,
  );
  const link = JSON.parse(
    await readFile(join(REPOSITORY, ".vercel", "project.json"), "utf8"),
  );
  const context = { env, head, dirty, origin, link };
  validateReleaseContext(context);
  const cliEntry = await resolveVercelEntry(env);
  const cli = (args, timeout) =>
    run(
      process.execPath,
      [cliEntry, ...args, "--non-interactive", "--scope", TEAM],
      REPOSITORY,
      env,
      timeout,
    );
  // First-class inspect proves the installed CLI can resolve this exact existing project.
  await cli(["project", "inspect", link.projectId]);
  // Inspect omits structured repository/team IDs; GET-only fallback supplies admission fields.
  const remoteProject = JSON.parse(
    await cli([
      "api",
      `/v9/projects/${link.projectId}?teamId=${link.orgId}`,
      "--raw",
    ]),
  );
  const remoteTeam = JSON.parse(
    await cli(["api", `/v2/teams/${link.orgId}`, "--raw"]),
  );
  validateReleaseContext({ ...context, remoteProject, remoteTeam });
  const initial = JSON.parse(
    await cli([
      "api",
      `/v13/deployments/${env.E2E_REDEPLOY_INITIAL_DEPLOYMENT_ID}?teamId=${link.orgId}`,
      "--raw",
    ]),
  );
  validateDeploymentProof(initial, env);
  // Close the guard-to-upload window for ordinary local edits.
  validateReleaseContext({
    ...context,
    head: await run("git", ["rev-parse", "HEAD"], REPOSITORY, env),
    dirty: await run(
      "git",
      ["status", "--porcelain", "--untracked-files=all"],
      REPOSITORY,
      env,
    ),
    remoteProject,
    remoteTeam,
  });
  const output = await cli(
    [
      "deploy",
      "--prod",
      "--force",
      "--project",
      link.projectId,
      "--format",
      "json",
    ],
    20 * 60_000,
  );
  const payload = JSON.parse(output);
  const deployed = payload.deployment ?? payload;
  if (
    !/^dpl_[A-Za-z0-9]+$/.test(deployed.id ?? "") ||
    deployed.readyState !== "READY" ||
    deployed.target !== "production"
  )
    reject("REDEPLOY_READY_PRODUCTION_NOT_VERIFIED");
  const observed = JSON.parse(
    await cli([
      "api",
      `/v13/deployments/${deployed.id}?teamId=${link.orgId}`,
      "--raw",
    ]),
  );
  validateDeploymentProof(observed, env);
  console.log(
    JSON.stringify({ status: "READY", target: "production", commit: head }),
  );
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
)
  main().catch((error) => {
    // An uncertain deployment result must be inspected, never automatically retransmitted.
    const code =
      error instanceof Error && /^REDEPLOY_[A-Z_]+$/.test(error.message)
        ? error.message
        : "REDEPLOY_PROOF_FAILED";
    console.error(`${code}; inspect the existing deployment before any retry`);
    process.exitCode = 1;
  });
