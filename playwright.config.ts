import { defineConfig, devices } from "@playwright/test";
import { realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

const remote = !["localhost", "127.0.0.1", "[::1]"].includes(
  new URL(process.env.E2E_BASE_URL ?? "http://localhost:3000").hostname,
);
function privateRemoteDirectory(candidate: string | undefined): string {
  if (!candidate || !isAbsolute(candidate))
    throw new Error(
      "Remote E2E reports require existing absolute private directories.",
    );
  const resolved = resolve(candidate);
  const canonical = realpathSync(resolved);
  const same =
    process.platform === "win32"
      ? canonical.toLowerCase() === resolved.toLowerCase()
      : canonical === resolved;
  const delta = relative(realpathSync(process.cwd()), canonical);
  if (
    !same ||
    !statSync(canonical).isDirectory() ||
    !(isAbsolute(delta) || delta === ".." || delta.startsWith(".." + sep))
  )
    throw new Error(
      "Remote E2E artifacts must be outside public Git without symlink redirection.",
    );
  return canonical;
}
const outputDir = remote
  ? privateRemoteDirectory(process.env.E2E_OUTPUT_DIRECTORY)
  : (process.env.E2E_OUTPUT_DIRECTORY ?? "test-results");
const reportDir = remote
  ? privateRemoteDirectory(process.env.E2E_REPORT_DIRECTORY)
  : (process.env.E2E_REPORT_DIRECTORY ?? "playwright-report");
export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 60000,
  outputDir,
  reporter: [["list"], ["html", { open: "never", outputFolder: reportDir }]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3000",
    channel:
      process.env.PLAYWRIGHT_CHROMIUM_CHANNEL === "chromium"
        ? undefined
        : "chrome",
    trace: process.env.CI || remote ? "off" : "retain-on-failure",
    screenshot: remote ? "off" : "only-on-failure",
  },
  projects: [
    {
      name: "desktop",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 1000 },
      },
    },
  ],
});
