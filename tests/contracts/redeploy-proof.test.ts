import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const script = new URL("../../scripts/ops/redeploy-proof.mjs", import.meta.url);
const modulePath = script.href;
const { validateReleaseContext, validateDeploymentProof } = (await import(
  modulePath
)) as {
  validateReleaseContext(context: Record<string, unknown>): void;
  validateDeploymentProof(
    deployment: Record<string, unknown>,
    env: Record<string, string>,
  ): void;
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
    ])
      expect(() =>
        validateDeploymentProof({ ...observed, ...patch }, env),
      ).toThrow("REDEPLOY_READY_PRODUCTION_NOT_VERIFIED");
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
      "REDEPLOY_EXPLICIT_PERMISSION_REQUIRED; inspect the existing deployment before any retry\n",
    );
  });
});
