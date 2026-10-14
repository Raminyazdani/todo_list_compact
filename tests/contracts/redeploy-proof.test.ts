import { describe, expect, it } from "vitest";
import { spawnSync, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

const script = new URL("../../scripts/ops/redeploy-proof.mjs", import.meta.url);
const modulePath = script.href;
const {
  validateReleaseContext,
  validateDeploymentProof,
  acceptedDeploymentId,
  validateRedeploymentProof,
  readAcceptedDeployment,
  run,
} = (await import(modulePath)) as {
  validateReleaseContext(
    context: Record<string, unknown>,
    mode?: { readOnlyResume: boolean },
  ): void;
  acceptedDeploymentId(output: string): string;
  validateRedeploymentProof(
    deployment: Record<string, unknown>,
    initial: Record<string, unknown>,
    env: Record<string, string>,
    expectedId: string,
  ): void;
  readAcceptedDeployment(
    cli: (args: string[]) => Promise<string>,
    acceptedId: string,
    initial: Record<string, unknown>,
    env: Record<string, string>,
    link: Record<string, string>,
  ): Promise<unknown>;
  validateDeploymentProof(
    deployment: Record<string, unknown>,
    env: Record<string, string>,
  ): void;
  run(
    executable: string,
    args: string[],
    cwd: string,
    env: Record<string, string>,
    timeoutMs?: number,
    acceptedOperation?: boolean,
    observer?: { onSpawn(child: ChildProcess): void },
  ): Promise<string | { stdout: string; exitCode: number | null }>;
};
const sha = "a".repeat(40);
const env = {
  E2E_REDEPLOY_ALLOWED: "1",
  E2E_REDEPLOY_EXPECTED_SHA: sha,
  E2E_REDEPLOY_EXPECTED_PROJECT_ID: "prj_SyntheticProject",
  E2E_REDEPLOY_EXPECTED_TEAM_ID: "team_SyntheticTeam",
  E2E_REDEPLOY_INITIAL_DEPLOYMENT_ID: "dpl_SyntheticInitial",
};
const context = {
  env,
  head: sha,
  dirty: "",
  origin: "https://github.com/Raminyazdani/todo_list_compact.git",
  link: {
    projectId: env.E2E_REDEPLOY_EXPECTED_PROJECT_ID,
    orgId: env.E2E_REDEPLOY_EXPECTED_TEAM_ID,
    projectName: "ramin-life-os",
  },
  remoteProject: {
    id: env.E2E_REDEPLOY_EXPECTED_PROJECT_ID,
    accountId: env.E2E_REDEPLOY_EXPECTED_TEAM_ID,
    name: "ramin-life-os",
    link: { type: "github", org: "Raminyazdani", repo: "todo_list_compact" },
  },
  remoteTeam: {
    id: env.E2E_REDEPLOY_EXPECTED_TEAM_ID,
    slug: "ramin-yazdanis-projects",
  },
};

describe("Production redeployment operator admission (no provider calls)", () => {
  it("accepts only a clean exact commit, existing project/team and the authorized GitHub repository", () => {
    expect(() => validateReleaseContext(context)).not.toThrow();
    for (const patch of [
      { env: { ...env, E2E_REDEPLOY_ALLOWED: "0" } },
      { head: "b".repeat(40) },
      { dirty: " M app/page.tsx" },
      { origin: "https://github.com/other/todo_list_compact.git" },
      { link: { ...context.link, projectId: "prj_OtherProject" } },
      {
        remoteProject: {
          ...context.remoteProject,
          accountId: "team_OtherTeam",
        },
      },
      {
        remoteProject: {
          ...context.remoteProject,
          link: { ...context.remoteProject.link, repo: "other-repository" },
        },
      },
      { remoteTeam: { ...context.remoteTeam, slug: "other-team" } },
      { remoteTeam: null },
      { remoteProject: null },
      { env: { ...env, E2E_REDEPLOY_EXPECTED_PROJECT_ID: "arbitrary-name" } },
      { env: { ...env, E2E_REDEPLOY_INITIAL_DEPLOYMENT_ID: "" } },
    ])
      expect(() => validateReleaseContext({ ...context, ...patch })).toThrow();
  });

  it("requires observed READY production metadata matching exact provider identities", () => {
    const observed = {
      id: "dpl_SyntheticObserved",
      readyState: "READY",
      target: "production",
      projectId: env.E2E_REDEPLOY_EXPECTED_PROJECT_ID,
      ownerId: env.E2E_REDEPLOY_EXPECTED_TEAM_ID,
      name: "ramin-life-os",
    };
    expect(() => validateDeploymentProof(observed, env)).not.toThrow();
    for (const patch of [
      { readyState: "BUILDING" },
      { target: "preview" },
      { projectId: "prj_Other" },
      { ownerId: "team_Other" },
      { name: "other-app" },
      { aliasError: { code: "SYNTHETIC_ALIAS_ERROR" } },
      { checksConclusion: "failed" },
    ])
      expect(() =>
        validateDeploymentProof({ ...observed, ...patch }, env),
      ).toThrow("REDEPLOY_READY_PRODUCTION_NOT_VERIFIED");
  });

  it("retains an accepted ID from supported CLI JSON while requiring fresh terminal GET proof", () => {
    const stale = {
      id: "dpl_SyntheticAccepted",
      readyState: "BUILDING",
      target: null,
    };
    // Installed CLI54.21.1 wraps this snapshot and discards its final reconciliation GET result.
    const wrapped = JSON.stringify({ status: "ok", deployment: stale });
    expect(acceptedDeploymentId(wrapped)).toBe(stale.id);
    expect(acceptedDeploymentId(JSON.stringify(stale))).toBe(stale.id);
    expect(
      acceptedDeploymentId(
        JSON.stringify({ status: "error", deployment: stale }),
      ),
    ).toBe(stale.id);
    const initial = {
      id: env.E2E_REDEPLOY_INITIAL_DEPLOYMENT_ID,
      createdAt: 1000,
    };
    const fresh = {
      ...stale,
      readyState: "READY",
      target: "production",
      name: "ramin-life-os",
      projectId: env.E2E_REDEPLOY_EXPECTED_PROJECT_ID,
      ownerId: env.E2E_REDEPLOY_EXPECTED_TEAM_ID,
      createdAt: 2000,
      meta: { githubCommitSha: sha },
    };
    expect(() =>
      validateRedeploymentProof(fresh, initial, env, stale.id),
    ).not.toThrow();
    for (const patch of [
      { readyState: "BUILDING" },
      { meta: { githubCommitSha: "b".repeat(40) } },
      { createdAt: 999 },
      { id: initial.id },
    ])
      expect(() =>
        validateRedeploymentProof(
          { ...fresh, ...patch },
          initial,
          env,
          stale.id,
        ),
      ).toThrow();
    expect(() => acceptedDeploymentId("synthetic malformed output")).toThrow(
      "REDEPLOY_CLI_OUTPUT_INVALID",
    );
  });

  it("GET-only recovery permits an operator patch but retains exact target, source SHA and repository guards", () => {
    expect(() =>
      validateReleaseContext(
        {
          ...context,
          head: "b".repeat(40),
          dirty: " M scripts/ops/redeploy-proof.mjs",
        },
        { readOnlyResume: true },
      ),
    ).not.toThrow();
    expect(() =>
      validateReleaseContext(
        { ...context, origin: "https://github.com/other/repo.git" },
        { readOnlyResume: true },
      ),
    ).toThrow("REDEPLOY_REPOSITORY_MISMATCH");
    expect(() =>
      validateReleaseContext(
        { ...context, env: { ...env, E2E_REDEPLOY_EXPECTED_SHA: "" } },
        { readOnlyResume: true },
      ),
    ).toThrow("REDEPLOY_SHA_MISMATCH");
  });

  it("accepted deployment recovery executes exactly one GET and never invokes deploy", async () => {
    const argsSeen: string[][] = [];
    const accepted = {
      id: "dpl_SyntheticAccepted",
      readyState: "READY",
      target: "production",
      name: "ramin-life-os",
      ownerId: env.E2E_REDEPLOY_EXPECTED_TEAM_ID,
      projectId: env.E2E_REDEPLOY_EXPECTED_PROJECT_ID,
      createdAt: 2000,
      meta: { githubCommitSha: sha },
    };
    const initial = {
      id: env.E2E_REDEPLOY_INITIAL_DEPLOYMENT_ID,
      createdAt: 1000,
    };
    await expect(
      readAcceptedDeployment(
        async (args) => {
          argsSeen.push(args);
          return JSON.stringify(accepted);
        },
        accepted.id,
        initial,
        env,
        context.link,
      ),
    ).resolves.toEqual(accepted);
    expect(argsSeen).toEqual([
      [
        "api",
        `/v13/deployments/${accepted.id}?teamId=${context.link.orgId}`,
        "--raw",
      ],
    ]);
  });

  it("the actual runner refuses missing explicit authorization before invoking git, authentication or Vercel", () => {
    const result = spawnSync(process.execPath, [fileURLToPath(script)], {
      env: { ...process.env, E2E_REDEPLOY_ALLOWED: "0", PATH: "", Path: "" },
      encoding: "utf8",
      windowsHide: true,
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      "REDEPLOY_EXPLICIT_PERMISSION_REQUIRED; stage=admission; inspect the existing deployment before any retry\n",
    );
  });
});

describe("Bounded real child-process adapter (synthetic Node programs only)", () => {
  const fixtureOutput = JSON.stringify({
    status: "ok",
    deployment: {
      id: "dpl_SyntheticAccepted",
      readyState: "READY",
      target: "production",
    },
  });
  const childArgs = (source: string) => [
    "--input-type=module",
    "--eval",
    source,
  ];

  it.each([0, 23])(
    "accepted mode retains complete stdout and actual exit code %s",
    async (exitCode) => {
      const output = await run(
        process.execPath,
        childArgs(
          `process.stdout.write(${JSON.stringify(fixtureOutput)}); process.stderr.write("SYNTHETIC_PRIVATE_STDERR"); process.exitCode=${exitCode};`,
        ),
        process.cwd(),
        {},
        3000,
        true,
      );
      expect(output).toEqual({ stdout: fixtureOutput, exitCode });
      expect(acceptedDeploymentId((output as { stdout: string }).stdout)).toBe(
        "dpl_SyntheticAccepted",
      );
      expect(JSON.stringify(output)).not.toContain("SYNTHETIC_PRIVATE_STDERR");
    },
  );

  it("ordinary GET-command mode returns a string for success and rejects nonzero exit", async () => {
    await expect(
      run(
        process.execPath,
        childArgs('process.stdout.write("synthetic read");'),
        process.cwd(),
        {},
        3000,
      ),
    ).resolves.toBe("synthetic read");
    await expect(
      run(
        process.execPath,
        childArgs("process.exitCode=23;"),
        process.cwd(),
        {},
        3000,
      ),
    ).rejects.toThrow("REDEPLOY_COMMAND_FAILED");
  });

  it("incomplete accepted stdout remains uncertain and cannot identify an operation for read-back", async () => {
    const output = (await run(
      process.execPath,
      childArgs(
        'process.stdout.write("{\\\"deployment\\\":"); process.exitCode=23;',
      ),
      process.cwd(),
      {},
      3000,
      true,
    )) as { stdout: string };
    expect(() => acceptedDeploymentId(output.stdout)).toThrow(
      "REDEPLOY_CLI_OUTPUT_INVALID",
    );
  });

  it.each([
    [
      "REDEPLOY_COMMAND_TIMEOUT",
      `process.stdout.write(${JSON.stringify(fixtureOutput)}); setInterval(()=>{},1000);`,
      250,
    ],
    [
      "REDEPLOY_OUTPUT_LIMIT",
      'process.stdout.write(Buffer.alloc(1024*1024,"x")); process.stderr.write(Buffer.alloc(1024*1024+1,"y")); setInterval(()=>{process.stdout.write("more output");},10);',
      3000,
    ],
  ])(
    "%s rejects, terminates the actual child and stops observation even in accepted mode",
    async (code, source, timeout) => {
      let childHandle: ChildProcess | undefined;
      let resolveClose!: () => void;
      const closed = new Promise<void>((resolve) => {
        resolveClose = resolve;
      });
      const result = run(
        process.execPath,
        childArgs(String(source)),
        process.cwd(),
        {},
        Number(timeout),
        true,
        {
          onSpawn(child) {
            childHandle = child;
            child.once("close", resolveClose);
          },
        },
      );
      await expect(result).rejects.toThrow(String(code));
      await closed;
      expect(childHandle?.killed).toBe(true);
      expect(
        childHandle?.exitCode !== null || childHandle?.signalCode !== null,
      ).toBe(true);
    },
  );
});
