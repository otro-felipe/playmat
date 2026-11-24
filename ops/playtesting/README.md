# Private playtesting

[Product specification and acceptance scenarios](../../docs/specs/playtesting/one-shot.md)

## Private response-idle timeout

Authenticated private unrated two-human-engine-seat games with spectators disabled default to a fifteen-minute response window. `PLAYMAT_PRIVATE_RESPONSE_IDLE_SECONDS` explicitly accepts 60–3600 seconds in that scope; missing, blank or invalid values use 900. Public, ranked, tournament, spectated, AI and other multiplayer modes keep their existing idle policy. This is independent of the cumulative match clock: disabling that clock does not disable response inactivity. Only accepted engine answers and new prompts change the window; polling, chat and resync do not renew it. The own-seat server deadline is exposed to MCP and a small human-facing countdown. See [timing, configuration and verification](../../docs/mcp-decision-timing.md). Deploy the new engine JAR/core/frontend together and do not assume older checkpoint fingerprints are compatible.

## Run in Docker

```sh
docker compose -f ops/playtesting/compose.yml up --build --wait
```

Open http://127.0.0.1:8794. Provision users with the command below. The local stack uses an isolated PostgreSQL volume and HTTP-only fixture cookies. Without a configured S3 endpoint or AWS bucket, replays stay in the upload queue. Configure an S3 backend to exercise interrupted replay archival and downloads locally.

## Engine restarts and active matches

Private Java PvP/MCP matches started with `PLAYMAT_PVP_RECOVERY=on` can return through their stable `/recover/<match-id>` link after restarting the same engine image with its private durable volume. Both actual participants must agree to the last confirmed boundary before play resumes. The feature is off by default and cannot protect matches already running without checkpoints. Let those matches finish before updating or restarting a server.

Read the [private recovery guide](../../docs/recovery/pvp-recovery.md) before enabling it: exact engine compatibility, two-seat identity, claims, clock policy, sideboarding, backup and single-replica requirements are explicit there. The all-in-one image also starts consistent owner-only recovery backups on the existing volume (four copies, fifteen-minute interval); read the private status and restore procedure in that guide. The older `PLAYMAT_PVP_CHECKPOINTS=capture` flag remains capture-only and does not enable reconnect recovery. An interrupted replay is never used as an engine replay journal.

## Railway

Run one app replica, a private PostgreSQL service, and an S3 bucket. Mount the engine/replay spool volume at `/var/lib/playmat` and expose only the app port. Point Railway's health check to `/healthz`. It checks both PostgreSQL and the XMage server. The app contains Caddy, the private product service, the separate MCP transport, and XMage. The only public ingress is Caddy. Do not expose the internal HTTP or engine ports as Railway domains or TCP proxies.

Bind `DATABASE_URL` by reference to the private Postgres service. Set `PLAYMAT_PUBLIC_URL` to the canonical public HTTPS origin. List the allowed HTTPS origins in `XMAGE_ALLOWED_ORIGINS`, separated by commas. WebSocket and MCP requests use this list. Configure `PLAYMAT_S3_BUCKET`, optional `PLAYMAT_S3_ENDPOINT`, and AWS region and credentials through runtime secret variables. Railway Buckets use virtual-hosted requests. Set `PLAYMAT_S3_FORCE_PATH_STYLE=true` only for providers that need path style. Replay objects have content-addressed keys regardless of the bucket's provider versioning features.

Public registration uses `PLAYMAT_PUBLIC_URL` for email links. Set `PLAYMAT_POSTMARK_FROM` to the verified sender and `PLAYMAT_POSTMARK_TOKEN` as a secret runtime variable. Password sign-in for existing accounts works without Postmark configuration. Registration mail requires the transactional `outbound` stream. For a delivery-free provider contract check, use Postmark's public `POSTMARK_API_TEST` token in an isolated environment.

For public deployments, configure a managed Cloudflare Turnstile widget for the hostname in `PLAYMAT_PUBLIC_URL`. Set its public key as `PLAYMAT_TURNSTILE_SITE_KEY` and its secret as `PLAYMAT_TURNSTILE_SECRET` in the app service. Together they enable server-side challenge verification on email link requests and password sign-in. Set both together. Leaving both unset keeps the local and existing unconfigured environments usable.


A personal history reset accepts a fixed UTC timestamp via `PLAYMAT_HISTORY_RESET=USERNAME@YYYY-MM-DDTHH:MM:SSZ`. Startup reports the count hidden and newer closed matches. Remove the setting after verification. Reapplying it preserves newer matches. The account cutoff applies across its seats and respects its existing retention allowance. Other participants and physical archive retention keep their own policies.

## Public request budgets

The Railway ingress sets the visitor address using its edge-provided `X-Real-IP`. Caddy replaces the app's forwarding header, and a standalone container uses the TCP peer by default. Only publish Caddy's port. If another proxy is placed before Railway, verify the resulting source grouping before enabling public traffic.

Product endpoints group requests by source and operations with shared backing resources also enforce a per-account budget. Export, replay, and theory endpoints limit concurrent work. MCP limits authorization and RPC requests by source and account. WebSocket upgrades use the source budget and verify browser origins. The engine constrains pending frames, applies its connection quota before decoding requests, and shares a 24-call-per-minute budget for expensive RPCs across seats belonging to one account. Instance-wide budgets apply even when traffic has multiple sources. HTTP throttling returns `429` with `Retry-After`; the MCP adds `X-Playmat-Limit-Reason` and logs `MCP request limited` with that reason. Accounts listed in `PLAYMAT_TOURNAMENT_ADMIN_IDS` skip per-account MCP and product budgets, including their agent connections, so colocated pilots on one administrator account are bounded only by the source and instance-wide budgets. Railway keeps WebSockets open without its 15-minute HTTP limit; Caddy closes `/ws` after 12 hours so a revoked browser session cannot stay connected indefinitely.

## Provisioning

A standard OAuth connection selects any of the owner’s enabled MCP profiles by outer `playerId` on each seat call. Use `list_players` for the authorized roster. Each named profile owns its own engine seat and reservation. A profile-bound grant remains limited to its player. An account with no enabled profiles retains the original engine seat `mcp_<username>`. The prefix `mcp` is reserved at human registration. Historical matches retain their original seat identifiers and show the owner's name with the MCP label. The archive stores the playing client's declared model and reasoning effort when supplied to `join_game` or `create_game`. Older matches and clients that omit those fields have no recorded configuration.

The manual grants below are an operator-only compatibility path for independently scoped credentials. Their engine names stay distinct, and new manual grants cannot occupy the `mcp_` namespace. A legacy name collision preserves the existing owner and grant.

Pass newly chosen credentials from a masked or restricted write-only source. The provisioning command reads the password or bearer token from standard input. Keep values out of command arguments, shell transcripts, repositories and public logs.

```sh
docker compose -f ops/playtesting/compose.yml exec -T playmat node /opt/playtesting/product/provision.mjs human PLAYER < restricted-password-file
railway ssh --service playmat -- node /opt/playtesting/product/provision.mjs human PLAYER < restricted-password-file
railway ssh --service playmat -- node /opt/playtesting/product/provision.mjs agent OWNER CodexRival play,chat < restricted-rival-token-file
railway ssh --service playmat -- node /opt/playtesting/product/provision.mjs agent OWNER CodexLab library,history < restricted-lab-token-file
```

Without SSH, pass the output of `node ops/playtesting/product/prepare-provision.mjs < restricted-provisioning-input.json` directly to a write-only assignment of `PLAYMAT_PROVISION_ONCE`. Remove the variable after verifying provisioning. To deactivate a prior grant during the same deployment, include `revocations` in the restricted input with one `token` field per entry. The helper passes SHA-256 digests to the service. Account and grant creation use distinct engine names. Repeating the startup import leaves the same grants revoked and preserves existing passwords and scopes.

### Match history retention

Each account can access its 20 most recent closed matches, ordered by match start time. All games in a match share one slot, and active matches remain available outside the quota. The account's human and agent seats share that quota. Replay, exports, reviews, and statistics use the same retained set and the existing seat permissions.

Set `PLAYMAT_UNLIMITED_HISTORY_USERS` to a comma-separated list of verified account usernames to persist unlimited retention at startup. An unknown username stops startup before history maintenance. Remove the variable after the exemptions have been applied so a later CLI change is durable. Operators can also change an individual account through the existing provisioning command.

```sh
node /opt/playtesting/product/provision.mjs history USERNAME unlimited
node /opt/playtesting/product/provision.mjs history USERNAME default
```

Enable `PLAYMAT_PURGE_EXPIRED_MATCH_HISTORY=true` after configuring the exemptions, verifying a restorable database and object-store backup, and confirming the application's bucket credential can delete objects. The archive worker then removes closed matches when every participant account is outside its retention window. It deletes dependent review data and replay-linked studies, queues object deletion with a short grace period for reads already in progress, and retries bucket errors. Any participant who retains the match keeps its underlying archive available. Verify bucket versioning and lifecycle settings when measuring reclaimed storage.

Open the site, log in and import a deck. In **Tables**, choose a friend, an MCP rival or native XMage AI. Enter the provisioned engine name for a friend. For an MCP rival, copy the link to a play-scoped agent session with its own decklist. Use a separate `CodexLab` session for library and match history. Start when the table shows both seats are ready.

```sh
codex mcp add playmat --url https://<public-host>/mcp --bearer-token-env-var PLAYMAT_MCP_TOKEN
```

The [MCP playbook](mcp/README.md) describes the decision loop. Keep the token in a private environment variable. Restart Codex or activate the connection before asking it to join.

## Private browser session and deck libraries

The product cookie remains the browser's login. A private web build connects its engine seat in the background,
checks the cookie identity against the proxy's sign-on identity, and never paints the public XMage login form.
An expired cookie returns to the product login. A connection already open elsewhere requires an explicit take-back.

Private libraries and deck pickers start with zero shipped starter decks. Initial account synchronization shows a
loading state rather than substituting starters; cached decks remain available after a failed sync with an error.
Account switches reset the visible shelf and discard late responses from the old connection.

The web library separates **My decks** and **AI opponent · MCP**. New agent-created decks automatically belong to
the latter; MCP `list_decks` reads that reusable shelf, while `get_deck` can still read an authorized known deck ID.
All existing decks remain personal on migration. The owner can explicitly move them between shelves without
deleting them or changing their IDs/history. Classification belongs to the server, not submitted deck metadata.
Browser sync reads both shelves; the additive `decks.library` column has a personal default. The scoped listing
accepts `?library=personal|agent`, and owner-only `POST /api/playtesting/decks/<id>/library` uses
`{library, expectedRevision}`. Existing grants, authentication and account ownership are unchanged.

In private games, tapping a mana source during payment applies its usable mana to the pending cost through
XMage's restricted pool payment. If you tap a land with several mana options, choose which mode or color it produces.
You can also select floating mana from the pool or press **AUTO PAY** to choose
sources for the current payment. Full Control lets you spend mana manually after tapping sources.

## Browser WebMCP

Choose **Friend** and share that invitation with the named player. Open it in a browser that supports site tools, sign in as that player, and select a deck. The page exposes `join_match`. The player's active game exposes `get_match_state`, `wait_for_decision`, and `submit_choice`.

The [native Chromium acceptance test](../../Mage.Web.Client/e2e/app-private-webmcp.spec.ts) uses two provisioned QA browser accounts and a private server. Supply their credentials through the protected `PLAYMAT_PRIVATE_QA_A_*` and `PLAYMAT_PRIVATE_QA_B_*` variables used by the browser suite. From the frontend test runner, opt in using `PLAYMAT_NATIVE_WEBMCP=1`, set both `PLAYMAT_PRIVATE_BASE_URL` and `MAGE_WEB_E2E_BASE_URL` to the test origin, and run `npx playwright test e2e/app-private-webmcp.spec.ts --project=chromium-desktop --workers=1`. Use `MAGE_CHROMIUM_EXECUTABLE` to point to a Chromium build with the native testing API.

## Constructed tournaments

Open `/tournaments` for public standings and registration. See the [tournament rules and organizer setup](../../docs/specs/playtesting/tournaments.md) for the three-round casual pilot, administrator role, deck publication and daily reconnect flow.
