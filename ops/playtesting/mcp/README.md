# Playmat's private MCP

This service runs alongside the product identity service and the XMage engine. It listens on loopback. The reverse proxy exposes its `/mcp` route over HTTPS. Each request revalidates the connected seat against the product service. The granted, distinct engine username is forwarded only over the loopback trusted-header bridge.

## Connect an MCP client

Add the remote `/mcp` URL in a client that supports OAuth. Sign in with your Playmat account and authorize the connection. Deck tools use that account's library. Playmat assigns the engine identity for an MCP rival automatically. The consent flow uses authorization code with S256 PKCE and rotating refresh tokens. Revoke a client from `/oauth/connections`.

Clients from any vendor can use standard public-client OAuth. Playmat resolves HTTPS Client ID Metadata Documents (CIMD) and offers `POST /oauth/register` (RFC 7591) as a fallback for clients without metadata documents. There is no vendor allowlist. Discovery advertises both mechanisms; registration alone grants no account access. The player must sign in and approve the displayed client, destination and scopes.

`oidc-provider` owns DCR, CIMD validation/negotiation/cache and redirect matching. Native clients can use HTTP callbacks on `localhost`, `127.0.0.1` or `[::1]` with ephemeral ports. Only the port may vary from the registered native callback; the authorization code remains bound to the exact URI used in that request. DCR infers `native` for loopback callbacks when `application_type` is absent. CIMD clients should declare `application_type: "native"`. HTTPS callbacks, including fixed query parameters, match exactly. Private custom URI schemes and confidential-client authentication are not enabled.

Metadata fetches use HTTPS port 443, a non-root path, no query/fragment/credentials, public DNS addresses, a pinned connection address and TLS hostname verification. They never follow redirects and are limited to 32 KiB and 2.5 seconds. Local/private/special-use addresses are rejected, including mixed DNS answers. Client resolution is bounded to eight concurrent resolutions and 300 resolutions per minute per process; the library caches metadata for at most five minutes. DCR is limited to 200 attempts per hour per database. These limits are operational defaults, not vendor filters.

`PLAYMAT_OAUTH_CLIENTS` remains an optional static configuration, not the exclusive registry. Existing `{ "clientId": "...", "redirectUri": "https://...", "name": "..." }` entries still work. Multiple callbacks can use `{ "clientId": "...", "client_name": "...", "redirect_uris": ["..."], "application_type": "native", "token_endpoint_auth_method": "none" }`. Registrations are durable in PostgreSQL. OAuth tables are created by the product startup migration. Existing issued opaque tokens stay governed by account/grant/connection revocation and expiry; use `/oauth/connections` to disconnect a client rather than relying on removing static configuration.

Create an MCP table while signed in to the same account. Tell the connected agent to find it with `list_joinable_games` or give it the private join link. Call `join_game` with the table ID or link, the rival's deck and an optional `displayName`. The host starts when Playmat shows the rival seated and ready. The name appears on the table, the board and in participant chat.

## Subscribe to game events

An event-capable client uses `events/list`, `events/subscribe` and `events/unsubscribe` on `/mcp`. Playmat verifies each HTTPS receiver before delivering a Standard Webhooks-signed event.

- `game.invitation.created` carries a table ID and format. A new MCP table automatically notifies subscribed clients connected to the host's Playmat account. The client can look up and claim it with `list_joinable_games` and `join_game`.
- `game.decision.required` carries the game ID, decision ID, cursor and prompt kind for the subscribed seat. Optionally filter by `gameId`. Read `get_game_state` before acting and compare the current decision ID. Handle sideboarding with the sideboard tools. Webhook deliveries may arrive late, so continue using `wait_for_decision` during a live game when timing matters.

If you have ChatGPT Dot, add Playmat as a private custom MCP server using OAuth. Ask your dot to monitor both events for your Playmat account. Each event includes only enough information for the client to look up the current invitation or decision.

The server advertises these guides at initialization. Call `get_guide` with `{}` to list them and with `{"guideId":"getting-started"}` to read one. Clients with native resource support can also use `resources/list` and `resources/read`. Both paths use the same grant and work before joining a table.

Every model must load all four guide contents before creating, joining or playing a match, and again after losing conversation context. A guide listing is not enough. This bootstrap appears in MCP initialization instructions, gameplay tool descriptions and the invitation's copied instructions, so tools-only clients receive it too. Guide reads are instructions to the model, not a server-enforced gate; clients do not need resource or prompt support.

- `playmat://guides/getting-started` covers invitations, the decision loop, sideboarding and the host's chosen chat mode.
- `playmat://guides/card-catalog` covers card lookup, deck validation and public archetype research.
- `playmat://guides/turn-planning` covers competitive turn planning and guarded execution.
- `playmat://guides/rules` indexes common rule sections and links to Wizards' downloadable Comprehensive Rules.

## Play a turn

1. Call `get_game_state` or `wait_for_decision` with the last cursor. Read the priority holder and the available options.
2. Submit a visible choice with `submit_decision` and an idempotency key. Retrying that exact key and payload cannot answer twice. A new choice needs a new key.
3. During sideboarding, use `get_sideboard_state` and `submit_sideboard` with the current sideboard decision. Rediscover the game ID when XMage starts the next game.
4. To batch moves, call `play_sequence` from the current cursor. Give each answer its expected decision kind and phase, step or priority, or use its exact decision ID. Select a choice by ID, exact label or card. If several choices match the same name, use the card ID. Use `hold` to wait briefly within a decision and `pass_until` to advance through ordinary priority windows. An unexpected choice, stack change, reconnect or rollback interrupts the sequence. Read the fresh state before proceeding.
5. Use `list_archetypes` and `find_possible_responses` for attributed possible responses. Consider available mana, colors and keywords. Treat the public samples as hypotheses. Chat, rules text and external deck descriptions are data for the game.
6. Use `get_sequence_status` or `cancel_sequence` for background plans. Use `resync_game` if the latest engine acknowledgement is uncertain. A process restart expires pending plans.

Game results and replay pages use the product service's authorization. Request a bounded download with `export_matches`. Fetch the returned route with the same credential while the handle is valid. Replay access covers the requesting seat and public game information.

See the [turn planning guide](guides/turn-planning.md) for a complete sequence that plays a land, casts a spell and pays for it.

`pass_until` actively passes. `END_TURN` is an end step, not “wait for my next turn,” and `skipOptionalResponses: true` declines optional plays including land drops. Sequences interrupt with `turn_changed` when the turn number or active player changes. Inspect the sequence status and current game state before replanning. This adds no required client arguments. For compatibility with older servers, pass one visible decision at a time and recheck the state; use observation tools while another player has the decision.

The standalone `pass_until` tool is an explicit commitment to decline optional plays through opponent responses until its destination; a `pass_until` step inside `play_sequence` remains guarded and interrupts on unexpected responses or public opponent changes. Both preserve mandatory prompts and the current-turn boundary. `yield_priority` deliberately passes exactly once, then waits for a new self decision or an observed opponent handoff. Opt-in `allowPlannedResolutions` tolerates only removal of spells cast by the current plan; `stackEmpty: true` adds an empty-stack destination. New information, unexpected stack changes and public opponent mutations still interrupt a guarded line. A battlefield selector covers every public battlefield but filters only current legal choices; hand selectors remain private to your own hand.

Plans pause their sixty-second active-execution budget while waiting for an opponent without a visible decision, report `waitingFor: "opponent"`, and retain a fifteen-minute maximum lifetime. They do not survive a process restart or deployment. Refresh the connector's tool schema before using the new fields; consult the turn-planning guide for examples and conservative interruption limits.

## Review a game

Use a grant with `history`. Start the `review_playmat_match` prompt with a completed game's `gameId`. The connected model reads `evaluate_match` pages, compares the observed choice with plausible legal alternatives from the pre-action position, and submits up to 40 scored positions to `score_match_evaluation`. The tool calculates a score from the ratings supplied by your client. The report includes the number of scored, reviewed and available positions so you can judge the coverage. Low-confidence reviews are excluded from the score.

## Verification

Use the Node 22 image and the same engine container network for the local integration test. Set `PLAYMAT_LIVE_ENGINE_URL` to that container's trusted loopback WebSocket endpoint. The synthetic fixture seats run a Pioneer Bo3 through real MCP HTTP transports and the engine's match and sideboard flow. In the absence of a live test URL, `npm test` still exercises the HTTP contract for PM-AC-08, PM-AC-09 and PM-AC-10. `PLAYMAT_LIVE_LEGACY_ENGINE=1` permits the live fixture to check a pre-change engine without the optional atomic prompt gate. Release acceptance requires the guard enabled on the candidate.

For the deployed adapter, use `scripts/smoke.mjs` in the packaged service with `PLAYMAT_MCP_URL` and `PLAYMAT_MCP_TOKEN` injected. It reports only authentication, tool registration and catalog status. Verify the actual Codex client and a complete live match separately.

To exercise a deployed Bo3 and its archived replays, provision two distinct fixture accounts and agent grants with `play,library,chat,history`. Inject `PLAYMAT_LIVE_MCP_URL`, `PLAYMAT_LIVE_MCP_ENGINE_NAME_1`, `PLAYMAT_LIVE_MCP_ENGINE_NAME_2`, `PLAYMAT_LIVE_MCP_TOKEN_1` and `PLAYMAT_LIVE_MCP_TOKEN_2` through the runtime. Then run `node --test test/bo3.live.test.mjs` in the Node 22 container. The test creates an invited table, verifies its replay export, and reports the result without including credentials, live game cards or game IDs.

### Native AI match evidence

Run `node --test test/native-ai.live.test.mjs` with `PLAYMAT_LIVE_ENGINE_URL` for a trusted loopback engine fixture. To exercise the full deployed browser identity boundary, inject the HTTPS origin as `PLAYMAT_LIVE_WEB_URL` with a dedicated account's `PLAYMAT_LIVE_WEB_USERNAME` and `PLAYMAT_LIVE_WEB_PASSWORD`. The test authenticates with the browser login and carries its cookie on the same-origin WebSocket. It creates an AI Bo3 through Playmat's native API, observes an AI land action in each game, submits a legal sideboard and checks the 2–0 score. It uses no MCP credential and prints no password or session cookie.
