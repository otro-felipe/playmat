# Private playtesting

[Product specification and acceptance scenarios](../../docs/specs/playtesting/one-shot.md)

## Run in Docker

```sh
docker compose -f ops/playtesting/compose.yml up --build --wait
```

Open http://127.0.0.1:8794. Provision users with the command below. The local stack uses an isolated PostgreSQL volume and HTTP-only fixture cookies. Without a configured S3 endpoint or AWS bucket, replays stay in the upload queue. Configure an S3 backend to exercise recovery and downloads locally.

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

Open the site, log in and import a deck. In **Tables**, host a match and enter the invited player's provisioned engine name. Share the table link with the invited player. Invite `CodexRival` for a match and give its agent session an independent decklist. Use a separate `CodexLab` session to work with your library and match history. Start the match once both seats have a deck. For native AI, host with one AI seat.

```sh
codex mcp add playmat --url https://<public-host>/mcp --bearer-token-env-var PLAYMAT_MCP_TOKEN
```

The [MCP playbook](mcp/README.md) describes the decision loop. Keep the token in a private environment variable. Restart Codex or activate the connection before asking it to join.
