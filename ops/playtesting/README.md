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

## Provisioning

Pass newly chosen credentials from a masked or restricted write-only source. The provisioning command reads the password or bearer token from standard input. Keep values out of command arguments, shell transcripts, repositories and public logs.

```sh
docker compose -f ops/playtesting/compose.yml exec -T playmat node /opt/playtesting/product/provision.mjs human PLAYER < restricted-password-file
railway ssh --service playmat -- node /opt/playtesting/product/provision.mjs human PLAYER < restricted-password-file
railway ssh --service playmat -- node /opt/playtesting/product/provision.mjs agent OWNER CodexRival play,chat < restricted-rival-token-file
railway ssh --service playmat -- node /opt/playtesting/product/provision.mjs agent OWNER CodexLab library,history < restricted-lab-token-file
```

Without SSH, pass the output of `node ops/playtesting/product/prepare-provision.mjs < restricted-provisioning-input.json` directly to a write-only assignment of `PLAYMAT_PROVISION_ONCE`. Remove the variable after verifying provisioning. To deactivate a prior grant during the same deployment, include `revocations` in the restricted input with one `token` field per entry. The helper passes SHA-256 digests to the service. Account and grant creation use distinct engine names. Repeating the startup import leaves the same grants revoked and preserves existing passwords and scopes.

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
