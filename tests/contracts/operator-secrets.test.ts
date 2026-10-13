import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  realpath,
  rm,
  symlink,
  link,
  rename,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseEnv } from "node:util";
vi.mock("../../server/auth/config", () => ({ createAuth: vi.fn() }));
vi.mock("../../server/auth/db", () => ({ getAuthPool: vi.fn() }));
import { enrollOwner } from "../../scripts/ops/bootstrap-owner";
import {
  admitPrivatePath,
  writeExclusivePrivateJson,
} from "../../scripts/ops/private-paths.mjs";
import {
  EXPECTED_PROJECT,
  provisionSecrets,
} from "../../scripts/ops/provision-secrets.mjs";
import { createCiEnvironment } from "../../scripts/ops/ci-environment.mjs";
const exec = promisify(execFile);
let root: string, repository: string, privateDir: string, output: string;
const email = "synthetic-owner@example.invalid",
  origin = "http://localhost:3000",
  originalPassword = "synthetic-existing-password-long";
const services = () => ({
  findOwner: vi.fn().mockResolvedValue(null),
  signup: vi.fn().mockResolvedValue({ id: "synthetic-user" }),
  signin: vi.fn().mockResolvedValue({ id: "synthetic-user" }),
});
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "life-os-operator-"));
  repository = join(root, "repository");
  privateDir = join(root, "private");
  output = join(privateDir, "credentials.json");
  await mkdir(join(repository, ".vercel"), { recursive: true });
  await mkdir(privateDir);
  await writeFile(
    join(repository, ".vercel", "project.json"),
    JSON.stringify({
      projectId: EXPECTED_PROJECT.projectId,
      orgId: EXPECTED_PROJECT.orgId,
      projectName: EXPECTED_PROJECT.name,
    }),
  );
  vi.stubEnv("OWNER_EMAIL", email);
  vi.stubEnv("BETTER_AUTH_URL", origin);
  vi.stubEnv("OWNER_ID", "synthetic-workspace");
});
afterEach(async () => {
  vi.unstubAllEnvs();
  const canonical = await realpath(root),
    parent = await realpath(tmpdir());
  if (
    !canonical
      .toLowerCase()
      .startsWith(join(parent, "life-os-operator-").toLowerCase())
  )
    throw new Error("Unsafe temporary cleanup target.");
  await rm(canonical, { recursive: true, force: true });
});
describe("operator admission uses actual isolated filesystem and mocked hosted services", () => {
  it("CI-only environment generation cannot overwrite a real development file", async () => {
    const target = join(repository, ".env.local"),
      original = "SYNTHETIC_PRESERVED=original-value\n";
    await expect(
      createCiEnvironment({ directory: repository, ci: "false" }),
    ).rejects.toThrow(/explicit CI/);
    await expect(stat(target)).rejects.toMatchObject({ code: "ENOENT" });
    await writeFile(target, original);
    await expect(
      createCiEnvironment({ directory: repository, ci: "true" }),
    ).rejects.toMatchObject({ code: "EEXIST" });
    expect(await readFile(target, "utf8")).toBe(original);
  });
  it("an empty isolated CI workspace receives only localhost synthetic configuration", async () => {
    expect(
      await createCiEnvironment({ directory: repository, ci: "true" }),
    ).toMatchObject({ configured: true, synthetic_only: true });
    const generated = parseEnv(
      await readFile(join(repository, ".env.local"), "utf8"),
    );
    expect(new URL(generated.DATABASE_URL!).hostname).toBe("localhost");
    expect(generated.OWNER_EMAIL).toBe("owner@example.test");
    expect(generated.OWNER_ID).toBe("synthetic-ci-owner");
  });
  it("relative, repository, case aliases and nonexistent parents cannot admit credential writes", async () => {
    const api = services();
    for (const path of [
      "credentials.json",
      join(repository, "credentials.json"),
      join(repository, "credentials.json").toUpperCase(),
      join(root, "missing-parent", "credentials.json"),
    ])
      await expect(enrollOwner(path, api, repository)).rejects.toThrow();
    expect(api.signup).not.toHaveBeenCalled();
    expect(api.signin).not.toHaveBeenCalled();
  });
  it("an external junction into Git and hardlinked private files are rejected", async () => {
    const alias = join(privateDir, "alias");
    await symlink(repository, alias, "junction");
    await expect(
      admitPrivatePath(join(alias, "credentials.json"), {
        repositoryRoot: repository,
      }),
    ).rejects.toThrow(/outside Git/);
    await writeFile(output, "synthetic-placeholder");
    await link(output, join(privateDir, "hardlinked.json"));
    await expect(
      admitPrivatePath(output, { repositoryRoot: repository }),
    ).rejects.toThrow(/regular/);
  });
  it("an outside directory sharing a textual repository prefix is accepted and wx preserves an existing file", async () => {
    const prefix = repository + "-private";
    await mkdir(prefix);
    const path = join(prefix, "synthetic.json");
    await writeExclusivePrivateJson(
      path,
      { preserved: true },
      { repositoryRoot: repository },
    );
    await expect(
      writeExclusivePrivateJson(
        path,
        { preserved: false },
        { repositoryRoot: repository },
      ),
    ).rejects.toMatchObject({ code: "EEXIST" });
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      preserved: true,
    });
  });
  it("pending password exists before signup and accepted-uncertain retry signs in without a second signup", async () => {
    const api = services();
    let owner: { id: string } | null = null;
    api.findOwner.mockImplementation(async () => owner);
    api.signup.mockImplementation(async (_email: string, password: string) => {
      const saved = JSON.parse(await readFile(output, "utf8"));
      expect(saved.status).toBe("pending");
      expect(saved.password).toBe(password);
      owner = { id: "synthetic-user" };
      throw new Error("Synthetic accepted response lost");
    });
    await expect(enrollOwner(output, api, repository)).rejects.toThrow(
      /response lost/,
    );
    const before = JSON.parse(await readFile(output, "utf8"));
    expect(before.status).toBe("pending");
    expect(await enrollOwner(output, api, repository)).toMatchObject({
      enrolled: true,
      recovered_pending: true,
    });
    const after = JSON.parse(await readFile(output, "utf8"));
    expect(after.password).toBe(before.password);
    expect(after.status).toBe("enrolled");
    expect(after.user_id).toBe("synthetic-user");
    expect(api.signup).toHaveBeenCalledTimes(1);
    expect(api.signin).toHaveBeenCalledWith(email, before.password);
  });
  it("legitimate existing credentials verify through supported signin and remain byte-identical", async () => {
    const existing = JSON.stringify({
      email,
      origin,
      password: originalPassword,
      user_id: "synthetic-user",
      created_at: "2026-10-13T00:00:00Z",
    });
    await writeFile(output, existing);
    const api = services();
    api.findOwner.mockResolvedValue({ id: "synthetic-user" });
    await enrollOwner(output, api, repository);
    expect(await readFile(output, "utf8")).toBe(existing);
    expect(api.signup).not.toHaveBeenCalled();
    expect(api.signin).toHaveBeenCalledWith(email, originalPassword);
  });
  it("existing owner without credentials is never recreated and mismatched saved identity is never used", async () => {
    const api = services();
    api.findOwner.mockResolvedValue({ id: "synthetic-user" });
    await expect(enrollOwner(output, api, repository)).rejects.toThrow(
      /already exists/,
    );
    await expect(stat(output)).rejects.toMatchObject({ code: "ENOENT" });
    await writeFile(
      output,
      JSON.stringify({
        email: "synthetic-other@example.invalid",
        origin,
        password: originalPassword,
        status: "pending",
      }),
    );
    await expect(enrollOwner(output, api, repository)).rejects.toThrow(
      /identity/,
    );
    expect(api.signup).not.toHaveBeenCalled();
    expect(api.signin).not.toHaveBeenCalled();
  });
  it("enrolled credentials cannot create an owner in a different empty database", async () => {
    await writeFile(
      output,
      JSON.stringify({
        email,
        origin,
        password: originalPassword,
        status: "enrolled",
      }),
    );
    const api = services();
    await expect(enrollOwner(output, api, repository)).rejects.toThrow(
      /recovery/,
    );
    expect(api.signup).not.toHaveBeenCalled();
  });
  it("wrong project, team or project name rejects before local or hosted mutation", async () => {
    const envPath = join(privateDir, "operator.env"),
      original = "BETTER_AUTH_SECRET=synthetic-preserved-secret\n";
    await writeFile(envPath, original);
    const run = vi.fn();
    for (const override of [
      { projectId: "synthetic-other-project" },
      { orgId: "synthetic-other-team" },
      { projectName: "synthetic-other-name" },
    ]) {
      await writeFile(
        join(repository, ".vercel", "project.json"),
        JSON.stringify({
          projectId: EXPECTED_PROJECT.projectId,
          orgId: EXPECTED_PROJECT.orgId,
          projectName: EXPECTED_PROJECT.name,
          ...override,
        }),
      );
      await expect(
        provisionSecrets(
          {
            environment: "development",
            envPath,
            vercelBin: "synthetic-cli",
            ownerEmail: email,
          },
          { repositoryRoot: repository, run },
        ),
      ).rejects.toThrow(/mismatch/);
      expect(await readFile(envPath, "utf8")).toBe(original);
    }
    expect(run).not.toHaveBeenCalled();
  });
  it("a symlinked Vercel context cannot redirect environment writes", async () => {
    await rename(
      join(repository, ".vercel"),
      join(privateDir, "linked-vercel"),
    );
    await symlink(
      join(privateDir, "linked-vercel"),
      join(repository, ".vercel"),
      "junction",
    );
    const envPath = join(privateDir, "operator.env");
    await writeFile(envPath, "SYNTHETIC=unchanged");
    const run = vi.fn();
    await expect(
      provisionSecrets(
        {
          environment: "development",
          envPath,
          vercelBin: "synthetic-cli",
          ownerEmail: email,
        },
        { repositoryRoot: repository, run },
      ),
    ).rejects.toThrow(/regular local/);
    expect(run).not.toHaveBeenCalled();
    expect(await readFile(envPath, "utf8")).toBe("SYNTHETIC=unchanged");
  });
  it("only ignored exact .env.local admits development/preview; production and tracked files fail", async () => {
    await exec("git", ["init", "--quiet"], { cwd: repository });
    await writeFile(join(repository, ".gitignore"), ".env*\n");
    const envPath = join(repository, ".env.local");
    await writeFile(envPath, "BETTER_AUTH_SECRET=synthetic-preserved-secret\n");
    const run = vi.fn().mockResolvedValue(undefined),
      report = vi.fn();
    await provisionSecrets(
      {
        environment: "development",
        envPath,
        vercelBin: "synthetic-cli",
        ownerEmail: email,
      },
      { repositoryRoot: repository, run, report },
    );
    expect(run).toHaveBeenCalled();
    run.mockClear();
    await expect(
      provisionSecrets(
        {
          environment: "production",
          envPath,
          vercelBin: "synthetic-cli",
          ownerEmail: email,
          productionOrigin: "https://synthetic.example.invalid",
        },
        { repositoryRoot: repository, run },
      ),
    ).rejects.toThrow(/outside Git/);
    expect(run).not.toHaveBeenCalled();
    await exec("git", ["add", "--force", ".env.local"], { cwd: repository });
    await expect(
      provisionSecrets(
        {
          environment: "preview",
          envPath,
          vercelBin: "synthetic-cli",
          ownerEmail: email,
        },
        { repositoryRoot: repository, run },
      ),
    ).rejects.toThrow(/tracked/);
  });
  it("uncertain hosted update preserves generated values and retries use the same secrets without logging them", async () => {
    const envPath = join(privateDir, "operator.env");
    await writeFile(envPath, "BETTER_AUTH_SECRET=synthetic-preserved-secret\n");
    const run = vi
        .fn()
        .mockRejectedValueOnce(new Error("Synthetic remote outcome uncertain")),
      report = vi.fn();
    const input = {
        environment: "development",
        envPath,
        vercelBin: "synthetic-cli",
        ownerEmail: email,
      },
      options = { repositoryRoot: repository, run, report };
    await expect(provisionSecrets(input, options)).rejects.toThrow(/uncertain/);
    const saved = parseEnv(await readFile(envPath, "utf8"));
    expect(saved.BETTER_AUTH_SECRET).toBe("synthetic-preserved-secret");
    run.mockResolvedValue(undefined);
    await provisionSecrets(input, options);
    const retried = parseEnv(await readFile(envPath, "utf8"));
    expect(retried).toEqual(saved);
    expect(run.mock.calls[1][0].secret).toBe(run.mock.calls[0][0].secret);
    expect(JSON.stringify(report.mock.calls)).not.toContain(
      saved.BETTER_AUTH_SECRET!,
    );
    expect(JSON.stringify(report.mock.calls)).not.toContain(
      saved.TOKEN_ENCRYPTION_KEY!,
    );
  });
});
