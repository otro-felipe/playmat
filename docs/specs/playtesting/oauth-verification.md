# MCP OAuth verification — 2026-11-17

Local worktree: `/Users/felipepezoa/Desktop/mtg-trainer/playmat-oauth`. Branch: `codex/oauth-standard-clients`. Base: `a1b7eec2`. No deployment, production migration, production security configuration or real account credentials were used. The original `playmat-one-shot` worktree was not edited.

## Executed checks

| Check | Actual result |
| --- | --- |
| Product `npm test` in `node:22-bookworm-slim`, isolated PostgreSQL 17, `PLAYMAT_OAUTH_SDK_TEST=1` | 33 discovered, 32 passed, 1 Chromium-only test skipped, 0 failed |
| Product `npm test` in `mcr.microsoft.com/playwright:v1.61.0-noble`, isolated PostgreSQL, browser and SDK flags enabled | 33 passed, 0 skipped, 0 failed; followed by final focused rerun after preserving the explicit Fetch Metadata guard |
| Final `node --test oauth.test.mjs oauth-clients.test.mjs` in the same Playwright container, both flags enabled | 14 passed, 0 skipped, 0 failed |
| Caddy 2.11 `caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile` | Valid configuration, including `/oauth/register` |
| `git diff --check` | Passed |
| Dependency installation in Node 22 container | `oidc-provider@9.15.0` pinned in manifest and lockfile; npm reported 0 vulnerabilities at install time |

The Chromium test submits actual browser-generated consent headers, reaches a local callback by GET and verifies no referrer. The official SDK test uses the existing sibling MCP package's SDK 1.32.2 for discovery, DCR, generated S256 authorization, code exchange and refresh, bridged to the real local product HTTP server. Frontend and MCP dependency directories were mounted read-only from the original checkout. Every integration case creates and drops an isolated PostgreSQL schema.

The final checks used a dedicated `playmat-oauth-regression-pg` container, unrelated to the other agent's database. Example rerun from the worktree, with dependency directories present:

```sh
docker run --rm --link playmat-oauth-regression-pg:postgres \
  -e PLAYMAT_TEST_DATABASE_URL -e PLAYMAT_OAUTH_SDK_TEST=1 \
  -e PLAYMAT_OAUTH_BROWSER_TEST=1 \
  -v "$PWD:/source" -w /source/ops/playtesting/product \
  mcr.microsoft.com/playwright:v1.61.0-noble npm test
```

Supply a disposable fixture connection URL through `PLAYMAT_TEST_DATABASE_URL`. The database container was removed after verification, so recreate it before rerunning. No line/branch coverage percentage was measured.

## Regression detection

Three independent temporary copies were created inside a disposable Node 22 container. The worktree was mounted read-only. Each modified copy ran the relevant named test and exited 1 at the expected behavioral assertion:

| Temporary fault | Detecting assertion |
| --- | --- |
| Replace `AND k.redirect_uri=$4` with `AND $4::text IS NOT NULL` in the authorization-code query | Native DCR test rejected a token issued for another otherwise registered loopback port: `200 !== 400` |
| Remove the stored PKCE challenge comparison, retaining the grant-existence check | Native DCR test rejected a token issued for the wrong verifier: `200 !== 400` |
| Remove the DNS-answer public-address predicate from the reused target resolver | Transport test failed with `Missing expected rejection` for a mixed public/private answer |

All three faults were detected; none was written back to the worktree.

## Compatibility evidence and remaining acceptance

Live unauthenticated GETs through the local registry resolved both public documents:

- `https://chatgpt.com/oauth/codex/client.json`: native port `http://127.0.0.1:49152/callback` accepted; ChatGPT web callback rejected.
- `https://chatgpt.com/oauth/client.json`: its published HTTPS callback accepted; Codex loopback callback rejected. The library negotiated `none` from its advertised alternatives without fetching JWKS or enabling confidential authentication.

These checks did not authorize a user or issue real client tokens. Generic CIMD fixtures simulate native and web applications, including multi-method metadata, rather than claiming product-specific acceptance. Claude, Gemini, Antigravity, OpenCode, Codex and ChatGPT were not logged in or exercised as actual clients. Production deployment and end-user client acceptance remain outside this local task. HTTPS and HTTP loopback public clients are supported; confidential authentication and custom URI schemes remain unsupported.

Specification and exact cases: [PM-MCP-09 / PM-AC-20](oauth-clients.md). Dependency boundary and alternatives: [ADR](../../adrs/2026-11-17-mcp-oauth-client-registry.md).
