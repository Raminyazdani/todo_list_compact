type Dependencies = {
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
};

/** Fixture DCR retries only an explicit rejection before registration executes. */
export async function boundedRegistration(
  origin: string,
  metadata: Record<string, unknown>,
  dependencies: Dependencies = {},
): Promise<Response> {
  let target: URL;
  try {
    target = new URL(origin);
  } catch {
    throw new Error("OAUTH_REGISTRATION_ORIGIN_INVALID");
  }
  if (
    !["http:", "https:"].includes(target.protocol) ||
    target.origin !== origin ||
    target.username ||
    target.password
  )
    throw new Error("OAUTH_REGISTRATION_ORIGIN_INVALID");
  const request = dependencies.fetch ?? globalThis.fetch;
  const now = dependencies.now ?? Date.now;
  const sleep =
    dependencies.sleep ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const body = JSON.stringify(metadata);
  // The real provider's DCR limit is five requests per 60-second window.
  const deadline = now() + 65000;
  for (let attempt = 0; attempt < 3; attempt++) {
    const remaining = deadline - now();
    if (remaining <= 0)
      throw new Error("OAUTH_REGISTRATION_RETRY_BUDGET_EXCEEDED");
    let response: Response;
    try {
      response = await request(origin + "/api/auth/oauth2/register", {
        method: "POST",
        redirect: "manual",
        headers: { "Content-Type": "application/json" },
        body,
        signal: AbortSignal.timeout(Math.min(15000, Math.ceil(remaining))),
      });
    } catch {
      // A transport failure can follow acceptance. Never repeat an uncertain DCR.
      throw new Error("OAUTH_REGISTRATION_TRANSPORT_FAILED");
    }
    if (response.status !== 429 || attempt === 2) return response;
    const advertised =
      response.headers.get("Retry-After") ??
      response.headers.get("X-Retry-After");
    const observedAt = now();
    let milliseconds: number | undefined;
    if (advertised !== null && /^\d+$/.test(advertised)) {
      const seconds = Number(advertised);
      if (Number.isSafeInteger(seconds)) milliseconds = seconds * 1000;
    } else if (
      advertised !== null &&
      /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(
        advertised,
      )
    ) {
      const date = Date.parse(advertised);
      if (
        Number.isFinite(date) &&
        new Date(date).toUTCString() === advertised &&
        date >= observedAt
      )
        milliseconds = date - observedAt;
    }
    if (
      milliseconds === undefined ||
      milliseconds < 0 ||
      milliseconds + 250 >= deadline - observedAt
    )
      return response;
    try {
      await response.body?.cancel();
      await sleep(milliseconds + 250);
    } catch {
      throw new Error("OAUTH_REGISTRATION_RETRY_WAIT_FAILED");
    }
  }
  throw new Error("OAUTH_REGISTRATION_RETRY_BUDGET_EXCEEDED");
}
