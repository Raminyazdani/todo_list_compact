import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, writeFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
let folder: string, path: string;
const target = "https://ramin-life-os.vercel.app";
beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), "life-os-http-admission-"));
  path = join(folder, "credentials.json");
  await writeFile(
    path,
    JSON.stringify({
      email: "synthetic-owner@example.invalid",
      password: "synthetic-admission-password",
    }),
  );
  vi.resetModules();
  vi.stubEnv("TEST_CREDENTIALS_PATH", path);
  vi.stubEnv("HTTP_TEST_ORIGIN", target);
  vi.stubEnv("RUN_PRODUCTION_GRAPH_DEMO", "0");
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json(
        {},
        {
          headers: {
            "Set-Cookie": "synthetic-test=synthetic-cookie; HttpOnly",
          },
        },
      ),
    ),
  );
});
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  const canonical = await realpath(folder),
    parent = await realpath(tmpdir());
  if (
    !canonical
      .toLowerCase()
      .startsWith(join(parent, "life-os-http-admission-").toLowerCase())
  )
    throw new Error("Unsafe admission fixture cleanup.");
  await rm(canonical, { recursive: true, force: true });
  vi.resetModules();
});
describe("author-only production proof gate with mocked HTTP and actual isolated private paths", () => {
  it("ordinary ownerCookie calls remain local-only even when the production flag is set", async () => {
    vi.stubEnv("RUN_PRODUCTION_GRAPH_DEMO", "1");
    const { ownerCookie } = await import("./http-fixture");
    await expect(ownerCookie()).rejects.toThrow(/restricted/);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("an explicit option alone cannot enable production authentication", async () => {
    const { ownerCookie } = await import("./http-fixture");
    await expect(ownerCookie({ productionGraphDemo: true })).rejects.toThrow(
      /restricted/,
    );
    expect(fetch).not.toHaveBeenCalled();
  });
  it("the opt-in flag cannot authorize another hostname or origin alias", async () => {
    vi.stubEnv("RUN_PRODUCTION_GRAPH_DEMO", "1");
    vi.stubEnv("HTTP_TEST_ORIGIN", "https://ramin-life-os.vercel.app:443");
    const { ownerCookie } = await import("./http-fixture");
    await expect(ownerCookie({ productionGraphDemo: true })).rejects.toThrow(
      /restricted/,
    );
    expect(fetch).not.toHaveBeenCalled();
  });
  it("production credentials inside Git are rejected before any network call", async () => {
    vi.stubEnv("RUN_PRODUCTION_GRAPH_DEMO", "1");
    vi.stubEnv("TEST_CREDENTIALS_PATH", resolve("package.json"));
    const { ownerCookie } = await import("./http-fixture");
    await expect(ownerCookie({ productionGraphDemo: true })).rejects.toThrow(
      /outside Git/,
    );
    expect(fetch).not.toHaveBeenCalled();
  });
  it("only the exact target, explicit intent, flag and admitted private file reach the mocked sign-in", async () => {
    vi.stubEnv("RUN_PRODUCTION_GRAPH_DEMO", "1");
    const original = await readFile(path, "utf8");
    const { ownerCookie } = await import("./http-fixture");
    expect(await ownerCookie({ productionGraphDemo: true })).toBe(
      "synthetic-test=synthetic-cookie",
    );
    expect(fetch).toHaveBeenCalledOnce();
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe(
      target + "/api/auth/sign-in/email",
    );
    expect(vi.mocked(fetch).mock.calls[0][1]?.redirect).toBe("manual");
    expect(await readFile(path, "utf8")).toBe(original);
  });
});
