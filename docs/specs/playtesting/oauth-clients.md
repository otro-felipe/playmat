# MCP OAuth clients

This supplements [PM-MCP-08](one-shot.md) without changing account identity, deck persistence or engine authorization.

## Requirement: PM-MCP-09 — Vendor-independent public OAuth clients

Playmat SHALL accept compatible public clients through HTTPS Client ID Metadata Documents (CIMD), dynamic client registration (DCR), or optional static configuration. No client brand grants implicit trust or account access. Registration SHALL NOT create an account grant. Browser sign-in, explicit consent, S256 PKCE, state and resource binding remain mandatory.

### Scenario: PM-AC-20 — Standard client discovery and exact grant binding

- An unconfigured public client can discover the authorization server and use CIMD or RFC 7591 registration.
- DCR registrations survive a new provider instance. HTTP loopback callbacks infer a native application when `application_type` is omitted; CIMD native clients explicitly declare it.
- HTTPS callbacks match exactly, including fixed queries. Native loopback registrations permit changing only the port, on the same hostname/path/query. `localhost`, `127.0.0.1` and `[::1]` are distinct callback hosts.
- Consent displays the client identifier and complete callback. A local application destination is identified as such. Untrusted client names are escaped.
- The code is bound to the exact requested callback, client and MCP resource. Another port, client, resource or PKCE verifier cannot redeem it. Code and refresh races succeed once, credentials expire and revocation blocks their use.
- Metadata identity must match the fetched URL. The server negotiates only its supported public method and authorization/refresh grants from a CIMD document offering several choices. Confidential-only clients fail.
- Fetches reject unsafe URLs, private and special-use DNS answers, mixed public/private answers, redirects, oversized bodies, wrong media types and timeouts. A connection uses the validated address without a second DNS lookup.
- Invalid requests do not create registrations, consent, codes, connections or access tokens. Global registration abuse is bounded.

## Traceability

All cases below carry `[PM-AC-20]` in their test names:

| Automated case | Evidence |
| --- | --- |
| `DCR persists a generic native client and binds each code to the requested loopback port` | [HTTP/PostgreSQL](../../../ops/playtesting/product/oauth.test.mjs): durable registration, consent, exact code binding, concurrent code/refresh use, revoke |
| `CIMD resolves unconfigured clients, accepts native loopbacks and preserves exact HTTPS callbacks` | [HTTP/PostgreSQL](../../../ops/playtesting/product/oauth.test.mjs): synthetic external metadata, real library negotiation/cache, web and native flows |
| `DCR supports unnamed public web clients and matches their full HTTPS callback exactly` | [HTTP/PostgreSQL](../../../ops/playtesting/product/oauth.test.mjs): optional display name, web port/query binding, successful code exchange |
| `invalid DCR and CIMD never issue grants or redirect to unchecked destinations` | [HTTP/PostgreSQL](../../../ops/playtesting/product/oauth.test.mjs): rejected metadata and no partial writes, DCR limit |
| `expired consent, codes, access and refresh credentials fail independently` | [HTTP/PostgreSQL](../../../ops/playtesting/product/oauth.test.mjs): independently expired artifacts |
| `the official MCP SDK discovers, registers, authorizes and refreshes through standard HTTP` | [SDK integration](../../../ops/playtesting/product/oauth.test.mjs): official SDK 1.32.2 against local product HTTP |
| `metadata transport pins a single public DNS result and keeps the TLS hostname` | [Transport](../../../ops/playtesting/product/oauth-clients.test.mjs) |
| `metadata transport rejects private, mixed and special-use DNS answers before any connection` | [Transport](../../../ops/playtesting/product/oauth-clients.test.mjs) |
| `metadata transport refuses redirects, oversized bodies, wrong media types and stalled DNS` | [Transport](../../../ops/playtesting/product/oauth-clients.test.mjs) |

PM-AC-18 and PM-AC-19 continue to cover account/agent isolation, S256, state, CSRF, consent replay and actual Chromium consent navigation. Run the product suite with `PLAYMAT_TEST_DATABASE_URL`; include `PLAYMAT_OAUTH_BROWSER_TEST=1` and `PLAYMAT_OAUTH_SDK_TEST=1` in the Playwright 1.61.0 container with frontend and MCP dependencies installed. Each test uses its own schema in a disposable database. No coverage percentage is currently enforced or claimed.

## Limitations

Tests exercise the protocol, the official SDK and a local Chromium browser. They do not establish real login/integration compatibility for Claude, Gemini, Antigravity, OpenCode, Codex or ChatGPT. Live public metadata resolution is a separate read-only smoke, not a client login. The change is local and undeployed. Only public `none` clients with HTTPS or HTTP loopback callbacks are enabled; custom schemes and confidential authentication are outside this change.

See [the client-registry decision](../../adrs/2026-11-17-mcp-oauth-client-registry.md).
