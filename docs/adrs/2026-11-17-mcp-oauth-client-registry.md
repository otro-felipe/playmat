# MCP OAuth client registry

Date: 2026-11-17. Status: accepted for local implementation, undeployed. Supersedes: none. Superseded by: none.

## Context and drivers

The product authorization server advertised CIMD but recognized only configured clients and a built-in ChatGPT entry. Exact comparison against one fixed callback blocked native ephemeral ports. The user requested compatible clients of any brand and reuse of a maintained library. Existing account consent, opaque tokens, account grants and revocation must survive. Another branch is separately changing deck persistence.

## Decision

Pin `oidc-provider` 9.15.0 and use its Client model, PostgreSQL Client adapter and RFC 7591 registration handler. Enable its CIMD draft-03 implementation, including standard supported-method/grant negotiation and native RFC 8252 callback matching. Configure only public `none` authentication. Expose only the registration callback from this provider; its authorization, token, OIDC, management and JWKS routes are not mounted. Its schema needs a signing algorithm, so initialization uses an ephemeral process-local Ed25519 key solely for the otherwise unused provider configuration; it is not persisted, exposed or used for Playmat tokens. No client secret or registration access token is issued.

Playmat retains browser account consent, S256 verification, state, scope policy, exact requested redirect binding in stored codes, resource binding, opaque access/refresh tokens, rotation, revocation and existing grant/account checks. Native port flexibility applies only when starting authorization; exchanging a code still matches its stored redirect byte-for-byte. Valid access tokens do not require a network metadata lookup on every resource request. Removing static configuration is therefore not a revocation mechanism.

The application adds its public-client policy, bounded registration/resolution rates, metadata transport restrictions and durable registration storage. The transport reuses the existing public DNS address policy, pins the validated address under the original TLS hostname, refuses redirects and bounds time/body size. Client names and full destinations appear in consent; local destinations receive an explanatory notice. Machine OAuth endpoints use CORS without credentials; human consent/connection writes retain explicit same-origin checks.

## Alternatives evaluated

- The installed official MCP SDK 1.32.2 provides authorization-server routing and DCR, but no CIMD server resolver. The current v2 SDK moves those server helpers to frozen `server-legacy` and recommends a dedicated identity/OAuth library. Importing old handlers alone would leave the new client-resolution protocol to application code.
- Better Auth's maintained MCP/CIMD/provider packages provide a complete integrated authorization server. Adopting them here would also migrate account/session integration, token storage and signing behavior. That broader migration is unnecessary for this bounded client-compatibility correction.
- Migrating all grants to oidc-provider would similarly replace working consent and token persistence. The selected boundary reuses the library for the missing protocols while preserving current account security.
- Handwritten DCR/CIMD and vendor-specific redirect exceptions were rejected.

## Consequences and validation

There is no vendor registry prerequisite. Optional static entries remain for self-hosters. New tables store public registrations and hourly abuse counters. Local migrations run through normal product startup; no production security setting or deployment is part of this task. Public clients using unsupported URI schemes or confidential-only methods are rejected. CIMD remains experimental upstream; the exact version and acknowledged draft must be reviewed before dependency upgrades.

Affected specification: [PM-MCP-09 / PM-AC-20](../specs/playtesting/oauth-clients.md), existing PM-MCP-08 / PM-AC-18 / PM-AC-19. Protocol fixtures, PostgreSQL HTTP integration, official SDK integration, Chromium consent and temporary fault injection verify this boundary. Per-product login tests remain unperformed.

## Primary sources

- [MCP client registration](https://modelcontextprotocol.io/specification/latest/basic/authorization#client-registration)
- [Official SDK v2 migration](https://ts.sdk.modelcontextprotocol.io/v2/migration/upgrade-to-v2)
- [oidc-provider source and supported standards](https://github.com/panva/node-oidc-provider)
- [oidc-provider configuration](https://github.com/panva/node-oidc-provider/blob/main/docs/README.md)
- [Better Auth MCP integration](https://better-auth.com/docs/plugins/mcp)
