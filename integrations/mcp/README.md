# Authenticated MCP setup

The deployed endpoint is `/api/mcp` on the verified application origin. Use Streamable HTTP and Authorization Code with S256 PKCE. Protected-resource discovery lives at `/.well-known/oauth-protected-resource/api/mcp`; authorization-server discovery is `/.well-known/oauth-authorization-server/api/auth`.

Start with `tasks:read`; explicitly grant `tasks:write` only for authorized task changes. Browser login and OAuth consent use the same owner account. Access tokens expire in five minutes; supported clients can refresh. Revoking the attached owner session denies tokens carrying that session id.

Generic config (replace origin with the observed deployment):

```json
{
  "mcpServers": {
    "ramin-life-os": { "url": "https://YOUR_VERIFIED_ORIGIN/api/mcp" }
  }
}
```

OAuth-capable clients store their own tokens. Do not paste a password or token in a repository config. For local coding agents, `codex mcp add ramin-life-os --url https://YOUR_VERIFIED_ORIGIN/api/mcp` followed by the client's supported login flow is a manual installation action, not automatic authorization by a prompt.

Runtime smoke: `node scripts/ops/runtime-smoke.mjs <private-owner-credentials.json> <verified-origin>`. It uses genuine owner sign-in, dynamic native-client registration, authorization, consent and PKCE, exercises SDK tool discovery/create/read-back/retry, then archives only its own synthetic fixture. Use an isolated staging account by default. Production tests require owner-authorized synthetic data.

Sensitive waiver commits additionally require `human_confirmation_id` issued by `POST /api/v1/approvals` from the owner's browser after reviewing that exact `preview_id`. MCP clients cannot issue their own confirmation tickets.
