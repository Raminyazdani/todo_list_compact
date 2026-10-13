const key = process.env.AI_GATEWAY_API_KEY || process.env.VERCEL_OIDC_TOKEN;
if (!key) {
  console.log(
    JSON.stringify({ authenticated: false, reason: "missing_gateway_auth" }),
  );
  process.exit(0);
}
const credits = await fetch("https://ai-gateway.vercel.sh/v1/credits", {
  headers: { Authorization: `Bearer ${key}` },
  redirect: "error",
  signal: AbortSignal.timeout(15000),
});
const details = await credits.json();
console.log(
  JSON.stringify({
    status: credits.status,
    balance: details.balance,
    total_used: details.total_used,
    error_type: details.error?.type,
    error_code: details.error?.code,
    action_required: details.error?.message?.slice(0, 250),
  }),
);
const catalog = await fetch("https://ai-gateway.vercel.sh/v1/models", {
  signal: AbortSignal.timeout(15000),
}).then((response) => response.json());
console.log(
  JSON.stringify({
    candidate_models: catalog.data
      ?.filter(
        (model) =>
          /mini|flash|haiku/.test(model.id) &&
          /openai|anthropic|google/.test(model.id),
      )
      .slice(0, 20)
      .map((model) => ({
        id: model.id,
        pricing: model.pricing,
        context_window: model.context_window,
        type: model.type,
      })),
  }),
);
