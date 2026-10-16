import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  realpath,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { EXPECTED_PROJECT } from "../../scripts/ops/provision-secrets.mjs";

type Request = { bin: string; args: string[]; secret?: string; cwd: string };
type Activate = (
  input: { credentialPath: string; journalPath: string; vercelBin: string },
  options?: {
    repositoryRoot?: string;
    run?: (request: Request) => Promise<{ stdout: string }>;
    report?: (message: string) => void;
  },
) => Promise<{ configured: boolean; count: number }>;
const operatorModule = await import(
    pathToFileURL(join(process.cwd(), "scripts/ops/google-oauth-activate.mjs"))
      .href
  ),
  activate = operatorModule.activateGoogleOAuth as Activate;
const callback = "https://ramin-life-os.vercel.app/api/auth/callback/google",
  clientId = "123456-synthetic-client.apps.googleusercontent.com",
  clientSecret = "synthetic-google-client-secret-never-output";
const credentials = () => ({
  web: {
    client_id: clientId,
    client_secret: clientSecret,
    auth_uri: "https://accounts.google.com/o/oauth2/auth",
    token_uri: "https://oauth2.googleapis.com/token",
    redirect_uris: [callback],
  },
});
const metadata = (key: string) => ({
  key,
  type: "sensitive",
  target: ["production"],
  createdAt: 1893456000000,
  updatedAt: 1893456000000,
});
let root: string,
  repository: string,
  privateDirectory: string,
  credentialPath: string,
  journalPath: string,
  vercelBin: string;
const input = () => ({ credentialPath, journalPath, vercelBin });
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "life-os-google-oauth-"));
  repository = join(root, "repository");
  privateDirectory = join(root, "private");
  await mkdir(join(repository, ".vercel"), { recursive: true });
  await mkdir(privateDirectory);
  await writeFile(
    join(repository, ".vercel", "project.json"),
    JSON.stringify({
      projectId: EXPECTED_PROJECT.projectId,
      orgId: EXPECTED_PROJECT.orgId,
      projectName: EXPECTED_PROJECT.name,
    }),
  );
  credentialPath = join(privateDirectory, "client_secret_synthetic.json");
  journalPath = join(privateDirectory, "activation.json");
  vercelBin = join(privateDirectory, "synthetic-vercel.mjs");
  await writeFile(credentialPath, JSON.stringify(credentials()));
});
afterEach(async () => {
  const canonical = await realpath(root),
    parent = await realpath(tmpdir());
  if (
    !canonical
      .toLowerCase()
      .startsWith(join(parent, "life-os-google-oauth-").toLowerCase())
  )
    throw new Error("Unsafe temporary cleanup target.");
  await rm(canonical, { recursive: true, force: true });
});
describe("Private Google Web OAuth to fixed Production Vercel configuration", () => {
  it("persists_exact_intents_before_wire_and_only_adds_two_sensitive_production_values_via_stdin", async () => {
    const remote: ReturnType<typeof metadata>[] = [],
      report = vi.fn(),
      original = await readFile(credentialPath, "utf8"),
      requests: Request[] = [];
    const run = vi.fn(async (request: Request) => {
      requests.push(request);
      const journal = JSON.parse(await readFile(journalPath, "utf8"));
      expect(journal.values).toEqual({
        GOOGLE_CLIENT_ID: clientId,
        GOOGLE_CLIENT_SECRET: clientSecret,
      });
      expect(journal.target).toMatchObject({
        ...EXPECTED_PROJECT,
        environment: "production",
        callback,
      });
      expect(request.args.slice(-2)).toEqual([
        "--scope",
        EXPECTED_PROJECT.orgId,
      ]);
      expect(request.cwd).toBe(await realpath(repository));
      if (request.args[1] === "ls")
        return { stdout: JSON.stringify({ envs: remote }) };
      const key = request.args[2];
      expect(request.args).toEqual([
        "env",
        "add",
        key,
        "production",
        "--sensitive",
        "--yes",
        "--scope",
        EXPECTED_PROJECT.orgId,
      ]);
      expect(journal.steps[key]).toMatchObject({
        state: "sending",
        attempts: 1,
      });
      expect(journal.steps[key].intent_id).toMatch(/^[0-9a-f-]{36}$/);
      expect(request.secret).toBe(
        key === "GOOGLE_CLIENT_ID" ? clientId : clientSecret,
      );
      expect(JSON.stringify(request.args)).not.toContain(clientSecret);
      expect(JSON.stringify(request.args)).not.toContain(clientId);
      remote.push(metadata(key));
      return { stdout: "discarded CLI write output" };
    });
    expect(
      await activate(input(), { repositoryRoot: repository, run, report }),
    ).toMatchObject({ configured: true, count: 2 });
    expect(
      requests.filter((request) => request.args[1] === "add"),
    ).toHaveLength(2);
    expect(JSON.stringify(report.mock.calls)).not.toContain(clientSecret);
    expect(JSON.stringify(report.mock.calls)).not.toContain(clientId);
    expect(await readFile(credentialPath, "utf8")).toBe(original);
    expect(JSON.parse(await readFile(journalPath, "utf8"))).toMatchObject({
      status: "configured",
      steps: {
        GOOGLE_CLIENT_ID: { state: "confirmed" },
        GOOGLE_CLIENT_SECRET: { state: "confirmed" },
      },
    });
    const adds = requests.filter((request) => request.args[1] === "add").length;
    await activate(input(), { repositoryRoot: repository, run, report });
    expect(
      requests.filter((request) => request.args[1] === "add"),
    ).toHaveLength(adds);
  });
  it("rejects_wrong_project_team_or_name_before_journal_or_wire", async () => {
    const run = vi.fn();
    for (const override of [
      { projectId: "prj_synthetic_other" },
      { orgId: "team_synthetic_other" },
      { projectName: "synthetic-other" },
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
        activate(input(), { repositoryRoot: repository, run }),
      ).rejects.toThrow(/mismatch/);
    }
    expect(run).not.toHaveBeenCalled();
    await expect(readFile(journalPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
  it("rejects_environment_overrides_and_credentials_or_journal_inside_Git", async () => {
    const run = vi.fn();
    await expect(
      activate(
        { ...input(), environment: "preview" } as Parameters<Activate>[0],
        { repositoryRoot: repository, run },
      ),
    ).rejects.toThrow(/fixed Production/);
    await expect(
      activate(
        { ...input(), journalPath: join(repository, "private-journal.json") },
        { repositoryRoot: repository, run },
      ),
    ).rejects.toThrow(/outside Git/);
    await writeFile(
      join(repository, "credential.json"),
      JSON.stringify(credentials()),
    );
    await expect(
      activate(
        { ...input(), credentialPath: join(repository, "credential.json") },
        { repositoryRoot: repository, run },
      ),
    ).rejects.toThrow(/outside Git/);
    expect(run).not.toHaveBeenCalled();
  });
  it("rejects_bad_json_installed_clients_wrong_callback_and_non_google_endpoints_without_echoing_values", async () => {
    const run = vi.fn(),
      invalid = [
        "not JSON",
        JSON.stringify({ installed: credentials().web }),
        ...[
          { redirect_uris: [callback + "/"] },
          { auth_uri: "https://attacker.example.test/oauth" },
          { token_uri: "https://attacker.example.test/token" },
          { client_secret: "with newline\nvalue" },
        ].map((change) =>
          JSON.stringify({ web: { ...credentials().web, ...change } }),
        ),
      ];
    for (const content of invalid) {
      await writeFile(credentialPath, content);
      try {
        await activate(input(), { repositoryRoot: repository, run });
        throw new Error("Expected credential rejection");
      } catch (error) {
        expect(String(error)).not.toContain(clientSecret);
        expect(String(error)).not.toContain(clientId);
        expect(String(error)).toMatch(/Google|credential/);
      }
    }
    expect(run).not.toHaveBeenCalled();
  });
  it("refuses_unknown_existing_vars_and_never_force_overwrites_or_partially_adds_the_other_key", async () => {
    const run = vi.fn(async (request: Request) => {
      expect(request.args[1]).toBe("ls");
      return {
        stdout: JSON.stringify({ envs: [metadata("GOOGLE_CLIENT_SECRET")] }),
      };
    });
    await expect(
      activate(input(), { repositoryRoot: repository, run }),
    ).rejects.toThrow(/Existing or uncertain/);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][0].args).toContain("ls");
    expect(JSON.stringify(run.mock.calls)).not.toContain("--force");
    expect(JSON.parse(await readFile(journalPath, "utf8"))).toMatchObject({
      status: "blocked_existing_or_uncertain",
    });
  });
  it("resumes_partial_failure_with_same_values_and_skips_confirmed_keys", async () => {
    const remote: ReturnType<typeof metadata>[] = [],
      writes: Request[] = [];
    let fail = true;
    const run = async (request: Request) => {
      if (request.args[1] === "ls")
        return { stdout: JSON.stringify({ envs: remote }) };
      writes.push(request);
      const key = request.args[2];
      if (key === "GOOGLE_CLIENT_SECRET" && fail) {
        fail = false;
        throw new Error("Synthetic failure before acceptance");
      }
      remote.push(metadata(key));
      return { stdout: "" };
    };
    await expect(
      activate(input(), { repositoryRoot: repository, run, report: vi.fn() }),
    ).rejects.toThrow(/journal retained/);
    const prior = JSON.parse(await readFile(journalPath, "utf8"));
    expect(prior.steps.GOOGLE_CLIENT_ID.state).toBe("confirmed");
    expect(prior.steps.GOOGLE_CLIENT_SECRET.state).toBe("pending");
    expect(
      await activate(input(), {
        repositoryRoot: repository,
        run,
        report: vi.fn(),
      }),
    ).toMatchObject({ configured: true });
    expect(
      writes.filter((request) => request.args[2] === "GOOGLE_CLIENT_ID"),
    ).toHaveLength(1);
    const secrets = writes.filter(
      (request) => request.args[2] === "GOOGLE_CLIENT_SECRET",
    );
    expect(secrets).toHaveLength(2);
    expect(secrets[0].secret).toBe(secrets[1].secret);
    const after = JSON.parse(await readFile(journalPath, "utf8"));
    expect(after.values).toEqual(prior.values);
    expect(after.steps.GOOGLE_CLIENT_SECRET.intent_id).toBe(
      prior.steps.GOOGLE_CLIENT_SECRET.intent_id,
    );
  });
  it("accepted_but_uncertain_write_is_not_retransmitted_or_assumed_to_match_a_hidden_value", async () => {
    const remote: ReturnType<typeof metadata>[] = [],
      writes: Request[] = [];
    const run = async (request: Request) => {
      if (request.args[1] === "ls")
        return { stdout: JSON.stringify({ envs: remote }) };
      writes.push(request);
      remote.push(metadata(request.args[2]));
      throw new Error("Synthetic accepted response lost");
    };
    await expect(
      activate(input(), { repositoryRoot: repository, run, report: vi.fn() }),
    ).rejects.toThrow(/journal retained/);
    expect(JSON.parse(await readFile(journalPath, "utf8"))).toMatchObject({
      steps: { GOOGLE_CLIENT_ID: { state: "uncertain" } },
    });
    await expect(
      activate(input(), { repositoryRoot: repository, run, report: vi.fn() }),
    ).rejects.toThrow(/verification/);
    expect(writes).toHaveLength(1);
  });
  it("changed_credential_file_or_changed_project_after_inventory_fails_before_next_write", async () => {
    let reads = 0;
    const run = async (request: Request) => {
      expect(request.args[1]).toBe("ls");
      reads++;
      await writeFile(
        join(repository, ".vercel", "project.json"),
        JSON.stringify({
          projectId: "prj_other",
          orgId: EXPECTED_PROJECT.orgId,
          projectName: EXPECTED_PROJECT.name,
        }),
      );
      return { stdout: JSON.stringify({ envs: [] }) };
    };
    await expect(
      activate(input(), { repositoryRoot: repository, run }),
    ).rejects.toThrow(/journal retained/);
    expect(reads).toBe(1);
    await writeFile(
      join(repository, ".vercel", "project.json"),
      JSON.stringify({
        projectId: EXPECTED_PROJECT.projectId,
        orgId: EXPECTED_PROJECT.orgId,
        projectName: EXPECTED_PROJECT.name,
      }),
    );
    await writeFile(
      credentialPath,
      JSON.stringify({
        web: {
          ...credentials().web,
          client_secret: "synthetic-new-value-must-not-replace-original-intent",
        },
      }),
    );
    const second = vi.fn();
    await expect(
      activate(input(), { repositoryRoot: repository, run: second }),
    ).rejects.toThrow(/identity mismatch/);
    expect(second).not.toHaveBeenCalled();
  });
  it("default_spawn_keeps_values_out_of_process_args_and_consumes_secret_stdout_stderr", async () => {
    const calls = join(privateDirectory, "calls.jsonl"),
      remote = join(privateDirectory, "remote.json");
    await writeFile(remote, "[]");
    await writeFile(
      vercelBin,
      `import{readFile,writeFile,appendFile}from'node:fs/promises';const args=process.argv.slice(2);let input='';for await(const chunk of process.stdin)input+=chunk;const path=${JSON.stringify(calls)},store=${JSON.stringify(remote)};await appendFile(path,JSON.stringify({args,stdin:input,project:process.env.VERCEL_PROJECT_ID,org:process.env.VERCEL_ORG_ID,oauthInEnv:process.env.GOOGLE_CLIENT_SECRET??null})+'\\n');let envs=JSON.parse(await readFile(store,'utf8'));if(args[1]==='ls'){process.stdout.write(JSON.stringify({envs}));}else{envs.push({key:args[2],type:'sensitive',target:['production'],createdAt:1893456000000,updatedAt:1893456000000});await writeFile(store,JSON.stringify(envs));process.stdout.write(input);process.stderr.write(input);}`,
    );
    const stdout = vi.spyOn(process.stdout, "write"),
      stderr = vi.spyOn(process.stderr, "write"),
      report = vi.fn();
    try {
      expect(
        await activate(input(), { repositoryRoot: repository, report }),
      ).toMatchObject({ configured: true });
      const records = (await readFile(calls, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)) as {
        args: string[];
        stdin: string;
        project: string;
        org: string;
        oauthInEnv: string | null;
      }[];
      const writes = records.filter((record) => record.args[1] === "add");
      expect(writes).toHaveLength(2);
      expect(writes.map((record) => record.stdin)).toEqual([
        clientId + "\n",
        clientSecret + "\n",
      ]);
      expect(
        JSON.stringify(records.map((record) => record.args)),
      ).not.toContain(clientSecret);
      expect(
        JSON.stringify(records.map((record) => record.args)),
      ).not.toContain(clientId);
      expect(
        records.every(
          (record) =>
            record.project === EXPECTED_PROJECT.projectId &&
            record.org === EXPECTED_PROJECT.orgId,
        ),
      ).toBe(true);
      expect(JSON.stringify(stdout.mock.calls)).not.toContain(clientSecret);
      expect(JSON.stringify(stderr.mock.calls)).not.toContain(clientSecret);
      expect(JSON.stringify(report.mock.calls)).not.toContain(clientSecret);
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
    }
  });
});
