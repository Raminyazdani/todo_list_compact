/** Synthetic verification helpers respect the real server rate policy. */
export async function boundedSignIn(origin, credentials, dependencies = {}) {
  let target;
  try {
    target = new URL(origin);
  } catch {
    throw new Error("SIGN_IN_ORIGIN_INVALID");
  }
  if (
    !["http:", "https:"].includes(target.protocol) ||
    target.origin !== origin ||
    target.username ||
    target.password ||
    typeof credentials?.email !== "string" ||
    !credentials.email ||
    typeof credentials?.password !== "string" ||
    !credentials.password
  )
    throw new Error("SIGN_IN_INPUT_INVALID");
  const request = dependencies.fetch ?? globalThis.fetch;
  const now = dependencies.now ?? Date.now;
  const sleep =
    dependencies.sleep ??
    ((milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const deadline = now() + 30000;
  for (let attempt = 0; attempt < 3; attempt++) {
    const remaining = deadline - now();
    if (remaining <= 0) throw new Error("SIGN_IN_RETRY_BUDGET_EXCEEDED");
    let response;
    try {
      response = await request(origin + "/api/auth/sign-in/email", {
        method: "POST",
        redirect: "manual",
        headers: { "Content-Type": "application/json", Origin: origin },
        body: JSON.stringify({
          email: credentials.email,
          password: credentials.password,
        }),
        signal: AbortSignal.timeout(Math.min(15000, Math.ceil(remaining))),
      });
    } catch {
      // Network errors can contain request details. Never echo a private body.
      throw new Error("SIGN_IN_TRANSPORT_FAILED");
    }
    if (response.status !== 429 || attempt === 2) return response;
    const advertised =
      response.headers.get("Retry-After") ??
      response.headers.get("X-Retry-After");
    const observedAt = now();
    let milliseconds;
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
      if (Number.isFinite(date) && date >= observedAt)
        milliseconds = date - observedAt;
    }
    if (
      milliseconds === undefined ||
      milliseconds < 0 ||
      milliseconds + 250 > deadline - observedAt
    )
      return response;
    // Release only a response that will be retried. A final denial stays intact.
    try {
      await response.body?.cancel();
      await sleep(milliseconds + 250);
    } catch {
      throw new Error("SIGN_IN_RETRY_WAIT_FAILED");
    }
  }
  throw new Error("SIGN_IN_RETRY_BUDGET_EXCEEDED");
}
