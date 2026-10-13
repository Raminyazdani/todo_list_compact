import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
describe.skipIf(
  !process.env.TEST_CREDENTIALS_PATH ||
    process.env.RUN_TOKEN_EXPIRY_TEST !== "1",
)("Actual issued OAuth token expiration", () => {
  it("a previously valid provider-signed token is denied after its actual expiry", async () => {
    const info = JSON.parse(
      await readFile(
        join(
          dirname(process.env.TEST_CREDENTIALS_PATH!),
          "qa-expiring-token-private.json",
        ),
        "utf8",
      ),
    ) as { access_token: string; expires_at: number; origin: string };
    expect(
      ["localhost", "127.0.0.1"].includes(new URL(info.origin).hostname),
    ).toBe(true);
    const wait = info.expires_at - Date.now() + 1500;
    if (wait > 310000)
      throw new Error(
        "Unexpected issued OAuth expiry beyond the bounded test window.",
      );
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    const response = await fetch(
      info.origin + "/api/v1/query?operation=task_search",
      { headers: { Authorization: "Bearer " + info.access_token } },
    );
    expect(response.status).toBe(401);
  }, 320000);
});
