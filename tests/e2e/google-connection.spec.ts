import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";

const origin = process.env.E2E_BASE_URL ?? "http://localhost:3000";
const credentialsPath = process.env.E2E_CREDENTIALS_PATH;
const googleUrl =
  "https://accounts.google.com/o/oauth2/v2/auth?client_id=synthetic-client&state=synthetic-state";
test.describe.configure({ mode: "serial" });

function panel(page: Page) {
  return page.locator("section.panel").filter({
    has: page.getByRole("heading", {
      name: /Google Calendar.*(?:همگام|two-way)/,
    }),
  });
}
function connectButton(page: Page) {
  return panel(page).getByRole("button", {
    name: /اتصال یا ارتقای مجوز Google Calendar|Connect or upgrade Google Calendar permission/,
  });
}
async function settings(page: Page) {
  await page.goto("/settings");
  await expect(page.locator(".save-status")).toContainText(
    /متصل به سرور|Server connected/,
  );
  await expect(connectButton(page)).toBeEnabled();
}

test.beforeEach(async ({ request, context, page }) => {
  test.skip(
    !credentialsPath,
    "An authenticated isolated test session is required.",
  );
  test.skip(
    !["localhost", "127.0.0.1"].includes(new URL(origin).hostname),
    "Synthetic OAuth response tests run against the local application only.",
  );
  const credentials = JSON.parse(await readFile(credentialsPath!, "utf8"));
  let response: Awaited<ReturnType<typeof request.post>> | undefined,
    waited = 0;
  for (let attempt = 0; attempt < 3; attempt++) {
    response = await request.post("/api/auth/sign-in/email", {
      headers: { Origin: origin },
      data: { email: credentials.email, password: credentials.password },
    });
    if (response.status() !== 429 || attempt === 2) break;
    const headers = response.headers(),
      retry = headers["x-retry-after"] ?? headers["retry-after"];
    const seconds = retry
      ? Number.isFinite(Number(retry))
        ? Number(retry)
        : (Date.parse(retry) - Date.now()) / 1000
      : NaN;
    const delay = Math.ceil(seconds * 1000);
    if (!Number.isFinite(delay) || delay < 0 || waited + delay > 30000) break;
    waited += delay;
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
  expect(response?.ok(), "Private test-session sign-in").toBe(true);
  await context.addCookies((await request.storageState()).cookies);
  await page.route("**/api/v1/query*", async (route) => {
    const url = new URL(route.request().url()),
      body =
        route.request().method() === "POST"
          ? route.request().postDataJSON()
          : null;
    if (
      (body?.operation ?? url.searchParams.get("operation")) !==
      "system_capabilities"
    )
      return route.continue();
    const response = await route.fetch(),
      result = await response.json();
    return route.fulfill({
      response,
      json: {
        ...result,
        data: { ...result.data, oauth_client_configured: true },
      },
    });
  });
  // Every provider request is synthetic. Never send OAuth state or account data
  // to Google while exercising this UI regression suite.
  await page.route("https://accounts.google.com/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<h1>Synthetic Google authorization target</h1>",
    }),
  );
});

test("Google_connection_keeps_default_SDK_navigation_and_requested_scopes", async ({
  page,
}) => {
  let calls = 0,
    payload: Record<string, unknown> = {};
  await page.route("**/api/auth/link-social", async (route) => {
    calls++;
    payload = route.request().postDataJSON();
    await route.fulfill({ json: { url: googleUrl, redirect: true } });
  });
  await settings(page);
  await connectButton(page).click();
  await expect(page).toHaveURL(googleUrl);
  await expect(
    page.getByRole("heading", {
      name: "Synthetic Google authorization target",
    }),
  ).toBeVisible();
  expect(calls).toBe(1);
  expect(payload.provider).toBe("google");
  expect(payload.callbackURL).toBe(`${origin}/settings`);
  expect(payload.disableRedirect).toBeUndefined();
  expect(payload.scopes).toEqual([
    "https://www.googleapis.com/auth/calendar.readonly",
    "https://www.googleapis.com/auth/calendar.events.owned",
  ]);
});

test("Google_connection_fallback_is_cleared_while_pending_and_API_errors_are_inline", async ({
  page,
}) => {
  let calls = 0;
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/auth/link-social", async (route) => {
    calls++;
    if (calls === 1)
      return route.fulfill({ json: { url: googleUrl, redirect: false } });
    await held;
    return route.fulfill({
      status: 400,
      json: {
        code: "SYNTHETIC_CONNECT_ERROR",
        message: "Synthetic Google connection error",
      },
    });
  });
  await settings(page);
  await connectButton(page).click();
  const fallback = panel(page).getByRole("link", {
    name: /ادامه در Google|Continue in Google/,
  });
  await expect(fallback).toHaveAttribute("href", googleUrl);
  await connectButton(page).click();
  await expect(connectButton(page)).toBeDisabled();
  await expect(connectButton(page)).toHaveAttribute("aria-busy", "true");
  await expect(panel(page).getByRole("status")).toContainText(
    /در حال بازکردن|Opening/,
  );
  await expect(fallback).toHaveCount(0);
  await connectButton(page).evaluate((button: HTMLButtonElement) =>
    button.click(),
  );
  expect(calls).toBe(2);
  release();
  await expect(panel(page).getByRole("alert")).toHaveText(
    "Synthetic Google connection error",
  );
  await expect(connectButton(page)).toBeEnabled();
  await expect(fallback).toHaveCount(0);
});

test("Google_connection_network_failure_remains_visible_and_retryable", async ({
  page,
}) => {
  let calls = 0;
  await page.route("**/api/auth/link-social", async (route) => {
    calls++;
    await route.abort("connectionfailed");
  });
  await settings(page);
  await connectButton(page).click();
  await expect(panel(page).getByRole("alert")).toBeVisible();
  await expect(connectButton(page)).toBeEnabled();
  await expect(
    panel(page).getByRole("link", {
      name: /ادامه در Google|Continue in Google/,
    }),
  ).toHaveCount(0);
  expect(calls).toBe(1);
});

test("Google_connection_does_not_offer_an_untrusted_authorization_link", async ({
  page,
}) => {
  await page.route("**/api/auth/link-social", (route) =>
    route.fulfill({
      json: { url: "https://example.test/untrusted-oauth", redirect: false },
    }),
  );
  await settings(page);
  await connectButton(page).click();
  await expect(panel(page).getByRole("alert")).toBeVisible();
  await expect(connectButton(page)).toBeEnabled();
  await expect(
    panel(page).getByRole("link", {
      name: /ادامه در Google|Continue in Google/,
    }),
  ).toHaveCount(0);
  await expect(page).toHaveURL(`${origin}/settings`);
});
