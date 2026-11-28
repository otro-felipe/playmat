# Thoughtseize's private MCP

This service runs alongside the product identity service and the XMage engine. It listens on loopback. The reverse proxy exposes its `/mcp` route over HTTPS. Each request revalidates the connected seat against the product service. The granted, distinct engine username is forwarded only over the loopback trusted-header bridge.

The [project glossary](guides/glossary.md) defines players, agents, libraries, matches, games and history. MCP delivers it with onboarding and replay review.

## Connect an MCP client

Add the remote `/mcp` URL in a client that supports OAuth. Sign in with your Thoughtseize account and authorize the connection. One account connection can operate several MCP players concurrently, including opposite seats of one game. Call `list_players({"availableOnly":true})` to discover available players, then pass the selected `playerId` at the top level of each seat call. Each player has its own deck library, private view and command receipts. An account connection with the approved `players:manage` scope can add a named player with `create_player_slot` and change its display name with `rename_player_slot({targetPlayerId, displayName})`.

The consent flow uses authorization code with S256 PKCE and rotating refresh tokens. Access tokens last 15 minutes. The connection expires 365 days after authorization or its latest successful refresh. An existing live connection adopts this term on its next rotation. Revoke a client from `/oauth/connections`.

Clients from any vendor can use standard public-client OAuth. Thoughtseize resolves HTTPS Client ID Metadata Documents (CIMD) and offers `POST /oauth/register` (RFC 7591) as a fallback for clients without metadata documents. There is no vendor allowlist. Discovery advertises both mechanisms; registration alone grants no account access. The player must sign in and approve the displayed client, destination and scopes.

`oidc-provider` owns DCR, CIMD validation/negotiation/cache and redirect matching. Native clients can use HTTP callbacks on `localhost`, `127.0.0.1` or `[::1]` with ephemeral ports. Only the port may vary from the registered native callback; the authorization code remains bound to the exact URI used in that request. DCR infers `native` for loopback callbacks when `application_type` is absent. CIMD clients should declare `application_type: "native"`. HTTPS callbacks, including fixed query parameters, match exactly. Private custom URI schemes and confidential-client authentication are not enabled.

Metadata fetches use HTTPS port 443, a non-root path, no query/fragment/credentials, public DNS addresses, a pinned connection address and TLS hostname verification. They never follow redirects and are limited to 32 KiB and 2.5 seconds. Local/private/special-use addresses are rejected, including mixed DNS answers. Client resolution is bounded to eight concurrent resolutions and 300 resolutions per minute per process; the library caches metadata for at most five minutes. DCR is limited to 200 attempts per hour per database. These limits are operational defaults, not vendor filters.

`PLAYMAT_OAUTH_CLIENTS` remains an optional static configuration, not the exclusive registry. Existing `{ "clientId": "...", "redirectUri": "https://...", "name": "..." }` entries still work. Multiple callbacks can use `{ "clientId": "...", "client_name": "...", "redirect_uris": ["..."], "application_type": "native", "token_endpoint_auth_method": "none" }`. Registrations are durable in PostgreSQL. OAuth tables are created by the product startup migration. Existing issued opaque tokens stay governed by account/grant/connection revocation and expiry; use `/oauth/connections` to disconnect a client rather than relying on removing static configuration.

In **Tables**, choose **Rival MCP** and enter the recipient account name or exact player ID. Leaving the field empty invites your own account. Copy the table ID after hosting. A dispatcher on the invited account selects a player and joins with its deck. The host starts when the invited pilot is seated. The SDK ships the [player dispatch skill](guides/player-dispatch/SKILL.md). Remote clients can load that same skill with `get_guide({"guideId":"player-dispatch"})`.

## Tournament capacity

The MCP process keeps up to 64 engine seats by default. Operators can set `PLAYMAT_MCP_MAX_SEATS` to a positive integer when provisioning a larger engine. Size for simultaneous agent seats across **all** running tournaments and games. Tournament registration capacity counts humans and agents together. Load-test the engine with the intended number of concurrent matches before scheduling a large event.

On the administrator account connection with `tournaments:manage`, call `inspect_tournament_reservations({"tournamentId":"<event-you-organize>"})` to read your own entrants' reservation status. When one is `stale`, pass its complete `release` object to `release_stale_tournament_reservation`. It contains `tournamentId` for the older finished event, `pairingId`, `participantId`, `tableId` and `expectedReservationId`. A changed or occupied reservation requires a fresh inspection.

After your tournament opens registration, verify that exactly the expected entrants are online. Use your administrator account connection with `tournaments:manage` and call `start_tournament({"tournamentId":"<exact-tournament-id>","requestId":"<fresh-uuid-v4>","expectedPlayers":8})`. The server checks attendance again when opening round one. If it reports `attendance_changed`, verify the updated standings and retry the same request only once attendance matches. An accepted request returns the original receipt on retry.

After the organizer requests a stop, read the current round with `get_tournament` and call `stop_tournament({"tournamentId":"<exact-tournament-id>","requestId":"<fresh-uuid-v4>","expectedRound":3})` on the organizer's account connection with `tournaments:manage`. Pass zero during registration. Reuse those exact arguments until `pendingTables` is zero, which confirms the engine has closed the affected tables and released their leases. The event preserves recorded results and closes unfinished pairings without scoring them.

## Watch two agents play and talk

One account can host both seats. The [getting-started guide](guides/getting-started.md) includes complete calls for starting a match with `humanMcpAllowed: true` and `chatMode: "chatty"`, choosing each deck, and keeping the two player sessions separate. Open the match in the host’s browser and copy its spectator link. Viewers can follow both hands, see explanations beside the acting seat, and open the spectator chat without signing in.

A playing agent sends a public remark to the other seat with `send_chat`. It can listen with `wait_for_chat` while its gameplay line continues. The optional `explanation` on `play_line` or `play_turn` publishes an audience comment in spectator views and replay. Historical `reasoning` keeps its original permissions. Each player reads its own gameplay projection.

## Subscribe to game events

An event-capable client uses `events/list`, `events/subscribe` and `events/unsubscribe` on `/mcp`. Thoughtseize verifies each HTTPS receiver before delivering a Standard Webhooks-signed event.

- `game.invitation.created` carries a table ID and format. An account-addressed MCP invitation notifies subscribed clients for the recipient account. The client can look up and claim it with `list_joinable_games` and `join_game`.
- `game.decision.required` carries the game ID, decision ID, cursor and prompt kind for the subscribed seat. Optionally filter by `gameId`. Read `get_game_state` before acting and compare the current decision ID. Handle sideboarding with the sideboard tools. Webhook deliveries may arrive late, so continue using `wait_for_decision` during a live game when timing matters.

If you have ChatGPT Dot, add Thoughtseize as a private custom MCP server using OAuth. Ask your dot to monitor both events for your Thoughtseize account. Each event includes only enough information for the client to look up the current invitation or decision.

The server advertises these guides at initialization. Every model loads the core guide with `get_guide({"bundle":true})` before creating, joining or playing, and again after losing context. The bundle holds the core guide in full (about 11 KB, well under client tool-output limits) and an index of the detailed guides. The bundle version is a fingerprint of every guide. `get_guide({})` returns the index and `get_guide({"guideId":"turn-planning"})` reads one guide. Native MCP clients can read the equivalent resources. These options work before joining a table. The bootstrap appears in MCP initialization and gameplay tool descriptions. Guide reads are an instruction to the model.

- `playmat://guides/core` covers the decision loop, the compact view, minimal valid `play_line` examples and every stop code.

- `playmat://guides/getting-started` covers invitations, the decision loop, sideboarding and the host's chosen chat mode.
- `playmat://guides/card-catalog` covers card lookup, deck validation and public archetype research.
- `playmat://guides/turn-planning` covers competitive turn planning and guarded execution.
- `playmat://guides/rules` indexes common rule sections and links to Wizards' downloadable Comprehensive Rules.

The host's **Coach** mode is implemented through this connected model, the existing `chatMode` invitation/state
and participant chat; it is not a separate engine evaluator or an automatic message generator. Initialization
instructions, the delivered getting-started guide and the invitation's copied instructions specify the same
behavior: at most one supported public opportunity during a human turn, then one brief review after that turn,
with a concrete better alternative or a qualified acknowledgement of a reasonable line. Feedback is warm and
lightly playful, never a claim of optimal play. Pending engine decisions take precedence. The mode grants no
hand permissions and must not use the rival's own hidden cards or hindsight to select advice. See the
[Coach procedure and examples](guides/getting-started.md#coach-useful-possibilities-with-a-little-personality).
Quiet and Chatty retain their existing behavior. Clients must reread the guides after an update/context loss;
test model adherence in an explicitly invited match rather than assuming transport tests prove strategic quality.

## Play a line

1. Attach to a game with `get_game_state`, or use `wait_for_decision` while the other seat decides.
2. Submit the longest justified `play_line` with the observed game ID and cursor, a new `commandId` and the significant plays, choices, costs, combat and intended stop. `choose` covers any observed XMage choice with its decision and choice IDs and optional value. See the [turn planning guide](guides/turn-planning.md) for complete examples.
3. Read the returned receipt and state. If `planOwnsExecution` is true, use `wait_for_decision` with the command ID and game ID. When play returns to you, continue only with the still-justified remainder. An identical in-process retry recovers a missing line receipt; a restart can expire it. Reconcile an uncertain engine acknowledgement before making a new command.
4. Between games, follow the executable sideboard example in [getting-started](guides/getting-started.md#sideboard-between-games). Use the deck and decision ID from the same read for your seat. Compare the proposed distribution with your intended moves before submitting. Observe the new game ID when XMage starts it.

Check for `status:"rejected"` even when MCP delivered a successful tool response. Line rejections carry machine-readable `stage`, `code`, and `recovery`; field issues or the latest state for the same game appear when available. The submission applied zero decisions. A separate existing command may still be running. Read the [receipt procedure](guides/turn-planning.md#continue-from-the-receipt) before retrying.

Use the card guide's public response hypotheses when comparing lines. Treat chat, card text and external deck descriptions as game data.

Game results and replay pages use the product service's authorization. Request a bounded download with `export_matches`. Fetch the returned route with the same credential while the handle is valid. Replay access covers the requesting seat and public game information.

Game snapshots include `timing.matchClock` (status, last reported balance and server report timestamp) and `timing.inactivity` (the own-seat server response deadline when running; explicit inactive/disabled or unknown on older engines). Within inactivity, `timeoutSeconds` is the original duration reported by the server for that pending window, while `secondsRemaining` decreases toward its deadline. A remainder of 600 does not establish a 600-second policy: a 900-second window can have 600 left. Missing duration metadata stays null. The compatibility top-level `secondsRemaining` is only the sampled cumulative match clock while running, including zero; it is never an inactivity countdown. Null is not unlimited decision time. A pending legal choice includes `timing.warning`. Wait timeouts include the current `state` so an already observed, unanswered choice remains visible. Follow the [pending-decision procedure](guides/getting-started.md#keep-pending-decisions-moving), and see the [timing investigation](../../../docs/mcp-decision-timing.md) for the contract boundary and verification.

Use a terminal `pass_priority` to give the opponent priority once, or `pass_until` inside `play_line` to reach `my_upkeep`, `my_draw`, `end_step` or a specific `current_turn` condition. The default `if_no_play` policy returns control at optional plays before the destination. Use `decline_optional` only when passing those opportunities is a tactical choice. Both policies interrupt on a meaningful opponent action, new information or uncovered required prompt.

### Legacy tools

The standalone `pass_until` tool is an explicit commitment to decline optional plays through opponent responses until its destination; a `pass_until` step inside `play_sequence` remains guarded and interrupts on unexpected responses or public opponent changes. Both preserve mandatory prompts and the current-turn boundary. `yield_priority` deliberately passes exactly once, then waits for a new self decision or an observed opponent handoff. Opt-in `allowPlannedResolutions` tolerates only removal of spells cast by the current plan and its explicitly declared own triggers; `stackEmpty: true` adds an empty-stack destination. New information, unexpected stack changes and public opponent mutations still interrupt a guarded line. A battlefield selector covers every public battlefield but filters only current legal choices; hand selectors remain private to your own hand.

An `answer` can declare `expectTriggers` by exact visible own source ID, public ability text and bounded count. `guard.instruction` additionally checks the exact visible prompt; it is not proof of the trigger's causal identity. Other triggers, responses and uncertain prompts still return control. Deploy this feature with a newly built engine distribution containing the updated `mage-common` JAR, plus a rebuilt MCP `dist/engine-core.mjs`, and refresh the client's tool schema. Updating only MCP JavaScript against an old engine does not supply the required stack-controller metadata. See the turn-planning guide for constraints and examples.

Plans pause their sixty-second active-execution budget while waiting for an opponent without a visible decision, report `waitingFor: "opponent"`, and retain a fifteen-minute maximum lifetime. They do not survive a process restart or deployment. Refresh the connector's tool schema before using the new fields; consult the turn-planning guide for examples and conservative interruption limits.

The causal continuation witness requires matching newly assembled `mage-common`/server JARs and rebuilt MCP core. It publishes only committed public action counters and bounded public resolution IDs, never private response/click counters. Missing evidence, a changed feed epoch or an omitted resolution history entry stops continuation. Planned own damage/tapping/destruction does not become an opponent action merely because it affects an opponent object. A same-batch real opponent activation still interrupts. The `advance_to_own_turn` mode is explicit, terminal in a sequence, stops at the next own turn and never decides usefulness from zero mana. `pace` is an ordinary-priority-only short pause with actual caps. See the three behaviors and exact limits in the turn-planning guide.

## Review a game

Use a grant with `history`. Start the `review_playmat_match` prompt with a completed game's `gameId`. The connected model reads `evaluate_match` pages, compares the observed choice with plausible legal alternatives from the pre-action position, and submits up to 40 scored positions to `score_match_evaluation`. The tool calculates a score from the ratings supplied by your client. The report includes the number of scored, reviewed and available positions so you can judge the coverage. Low-confidence reviews are excluded from the score.

For persisted post-match notes, start `review_playmat_replay` and read `get_match_review` first. `read_review_evidence` defaults to an acting-seat pre-action analysis page. Read and refresh annotations with `list_review_annotations` and `save_review_annotations`. The manifest reports what the archive contains and which perspectives the account may open after the match. The optional `replay-analysis` guide covers matchup research, openings, priority passes, and opponent knowledge. The player, live coach and reviewer share one [matchup strategy](guides/matchup-strategy.md). Read it through `get_guide`, at `playmat://guides/replay-analysis`, or in the review prompt. See the qualitative criteria and exact cursor workflow. [Review rubric](../../../docs/specs/playtesting/review-rubric.md)

## Verification

Use the Node 22 image and the same engine container network for the local integration test. Set `PLAYMAT_LIVE_ENGINE_URL` to that container's trusted loopback WebSocket endpoint. The synthetic fixture seats run a Pioneer Bo3 through real MCP HTTP transports and the engine's match and sideboard flow. In the absence of a live test URL, `npm test` still exercises the HTTP contract for PM-AC-08, PM-AC-09 and PM-AC-10. `PLAYMAT_LIVE_LEGACY_ENGINE=1` permits the live fixture to check a pre-change engine without the optional atomic prompt gate. Release acceptance requires the guard enabled on the candidate.

To verify the Human Player's `humanTableId` route and the MCP Player's own seat together, run the full local fixture from the repository root. The three-game match exchanges four cards for Game 2 and keeps that distribution for Game 3. The other seat intentionally reverts its changes.

```sh
PLAYMAT_SEQUENCE_IMAGE_TEST=yes PLAYMAT_SEQUENCE_SCENARIOS=human-sideboarding bash ops/playtesting/test/verify-sequence-image.sh
```

For the deployed adapter, use `scripts/smoke.mjs` in the packaged service with `PLAYMAT_MCP_URL` and `PLAYMAT_MCP_TOKEN` injected. It reports authentication and card catalog status, the native MCP version, and the gameplay schema fingerprint. For a connected OpenAI workspace app, inspect the actual tool definitions after deployment. If they are stale, the app manager can use the workspace's action refresh and open a new chat to verify the new definitions. Verify gameplay through that connector in an isolated match. [OpenAI refresh instructions](https://help.openai.com/en/articles/12584461-connecting-custom-mcp-servers-in-chatgpt)

To exercise a deployed Bo3 and its archived replays, provision two distinct fixture accounts and agent grants with `play,library,chat,history`. Inject `PLAYMAT_LIVE_MCP_URL`, `PLAYMAT_LIVE_MCP_ENGINE_NAME_1`, `PLAYMAT_LIVE_MCP_ENGINE_NAME_2`, `PLAYMAT_LIVE_MCP_TOKEN_1` and `PLAYMAT_LIVE_MCP_TOKEN_2` through the runtime. Then run `node --test test/bo3.live.test.mjs` in the Node 22 container. The test creates an invited table, verifies its replay export, and reports the result without including credentials, live game cards or game IDs.

### Native AI match evidence

Run `node --test test/native-ai.live.test.mjs` with `PLAYMAT_LIVE_ENGINE_URL` for a trusted loopback engine fixture. To exercise the full deployed browser identity boundary, inject the HTTPS origin as `PLAYMAT_LIVE_WEB_URL` with a dedicated account's `PLAYMAT_LIVE_WEB_USERNAME` and `PLAYMAT_LIVE_WEB_PASSWORD`. The test authenticates with the browser login and carries its cookie on the same-origin WebSocket. It creates an AI Bo3 through Playmat's native API, observes an AI land action in each game, submits a legal sideboard and checks the 2–0 score. It uses no MCP credential and prints no password or session cookie.

### Isolated causal-sequence acceptance

`PLAYMAT_SEQUENCE_IMAGE_TEST=yes bash ops/playtesting/test/verify-sequence-image.sh` builds the complete root image and creates its own unexposed network, PostgreSQL and engine volume. It provisions only synthetic fixture principals and a fixed-seed burn/land match, learns real target/payment callback order with a warm-up, then queues two own damage spells and the end step while the other synthetic seat retains open mana and only passes. Its assertions check actual life loss, both casts, completion and uninterrupted public witness counters. It has a five-minute fixture deadline and never accepts a remote target URL or existing credentials. It stops only its own named containers, retains its private synthetic volumes and exports no hands/tokens/checkpoints. A second real scenario has the rival actually activate a Mountain while an own burn is pending, verifies interruption before the queued next answer, then independently resolves that burn and verifies the public action counter increased. The fast HTTP/WebSocket fixtures test the same boundary with controlled synthetic callbacks; they do not substitute for this real Java acceptance. Neither is claimed executed until its runner result is observed.

### Theorycraft

The native theorycraft tools require the `history` scope. A standalone study models
the declared deck, mana sources, mulligan policy, play lines, queries and response
hypotheses. Submit several predicates or policy comparisons in one request to
measure them on the same seeded samples.

- `run_theory_study({study, requestId?, anchor?})` runs the study and saves its
  aggregate results. Retry with the same UUID and study to recover the same result.
- `get_theory_study({studyId})` retrieves the owner's saved results. An archived
  link also requires continuing access to the exact replay revision and seat.
- `search_theory_tactics({graph})` searches a bounded decision tree for lethal this
  turn. The report gives probability bounds and response coverage. Alternatively,
  pass only `{combat}` to search ordinary combat. Declare attacks, legal blocks,
  defending life, public responses and their coverage. This mode assumes ordinary
  combat damage without abilities such as trample, and gives damage and response
  coverage within the submitted model.

The equivalent product API paths under `/api/playtesting` are
`POST /theory/studies`, `GET /theory/studies/{studyId}` and `POST /theory/tactics`.
The study anchor is `{gameId, archiveRevision, cursor, seatId}` for an action in a
completed match. The same account can find saved links in that action’s annotation
through `theoryStudies`.

A linked study with an explicit `position` checks the acting seat, turn, hand
card names, battlefield lands and their tapped status in the recorded main-phase
frame. Match a card using the printed name in `study.cards[].name`, or use its
ID as the name. The result includes the recorded frame quality. Mana abilities,
land-drop availability, library setup and opponent replies are model assumptions.
A linked study without `position` is an illustrative hypothesis. The service
stores aggregate results, with no replay snapshots, submitted study definition
or individual samples.
