# Private PvP recovery

`PLAYMAT_PVP_RECOVERY=on` enables durable recovery for **new, private, unrated Java matches with exactly two product-authenticated human seats**. An MCP rival is a human engine seat. The feature is off by default. Tournament, AI-only/solo and Rust-hosted recovery are not provided by this feature; eligible opted-in matches stay on Java. The separate [capture-only pilot](pvp-checkpoints.md) remains available under its old flag.

Eligible tables must have spectators disabled; rated or spectated tables are not opted into this recovery flow.

Enabling this cannot save a match that started on an older server without these checkpoints. Do not restart a server with an existing unprotected active match to install it. Nothing in this branch deploys or restarts a service.

## Player flow and stable links

Open **Tables → Return to your saved private matches**, or `/recover`. Each admitted participant sees only the matches reserved to that exact human account or MCP grant. Keep the displayed `/recover/<original-match-id>` link; it remains valid across process/container replacement with the same engine image and durable volume. An original `/join/<table-id>` invitation also offers the authorized recovery link once its old table has disappeared.

The page shows the last confirmed boundary. Each participant must press **I agree to this saved boundary**. A single agreement creates no playable table and starts no clock. Both reserved participants must be authenticated, currently connected and have agreed to the same durable revision before one recovery claim creates the replacement table. Reloading/reconnecting requires reading the current boundary again. Repeated/simultaneous recovery calls reuse that table and game.

MCP equivalents require the existing `play` scope:

1. `list_recoverable_matches` obtains stable match IDs and links.
2. `get_recovery_status({matchId})` reads the confirmed revision, phase, message and ID mapping.
3. `recover_match({matchId, revision, agree:true})` explicitly agrees to that displayed boundary. `agree:false` reconnects an already live reserved seat without casting a new recovery vote.
4. Read current game state and decisions again. Old game IDs, decision IDs, cursors and queued plans are not reused. During restored sideboarding there is no fabricated active game; use `get_sideboard_state` and submit its current decision without a `gameId`.

## Durable boundaries and clocks

| Saved phase | What resumes after both agree |
| --- | --- |
| `turn` | Start of confirmed turn N, before untap. The full private snapshot restores ordered libraries, hands, cards, exile, permanents, effects, rule watchers/triggers and RNG. Decisions after N are discarded. |
| `pregame` | The game has no confirmed turn yet. Opening choices and mulligans restart with the saved decks, configuration, score and game number. This is displayed explicitly; it is not described as mid-decision continuation. |
| `sideboard` | Saved score/draws, chooser, decks and sideboard lists are restored. Both participants confirm their lists again in a fresh normal three-minute sideboard window, including a player who had submitted before the crash. |
| `completed` | No recovery action. A completed match cannot be reopened through this flow. |

Snapshots and their context commit together synchronously with SQLite `synchronous=FULL`. A write queued in memory is never called confirmed. Every successfully accepted sideboard update/submission also saves its current list before the waiting match can advance. A new game gets a `pregame` checkpoint before opening choices; normal game end saves the next sideboard boundary or marks completion. A rollback within a running match saves the newly chosen branch as the next durable revision.

Priority and buffer clocks restore to the confirmed turn boundary. Later decisions **and their time consumption** are discarded together. Downtime, agreement waiting and the game-session join barrier consume no match clock. Once both actual game sessions attach, normal engine timing resumes. Ordinary in-game rollback retains its existing spent-time policy; only durable snapshot recovery restores those clocks. Sideboarding uses the fresh window described above and does not consume priority clocks.

This is snapshot continuation, not reconstruction by replaying logs. A recorded replay is review material and is never used as a deterministic engine journal.

The response-idle watchdog is separate from the accumulated match clock. No game worker or response-idle future starts at the recovery agreement/join barrier. Once a restored game asks a real question, its normal engine response-idle policy starts again. `secondsRemaining` must not be interpreted as that response deadline, and an unknown/null value is not an unlimited clock. Polling is not a response and does not prevent an idle loss. Sideboarding has its separate callback-supplied deadline. Integrate the independent MCP clock contract from commit `bd769a450eace3f8c004016f2ffbcb6fe091573d` (`docs/mcp-decision-timing.md`) alongside this feature; recovery does not replace that contract.

## Identity, claims and hidden information

Product forward authentication supplies an immutable account UUID and either `human:<account UUID>` or `agent:<grant recovery UUID>`. Caddy strips incoming identity headers before copying verified ones. The trusted WebSocket handshake pins the principal, and successful engine login binds it to the actual seated user. Initial checkpoints record both actual seated principals; later snapshots cannot replace those participants.

Recovery checks the current account enablement, exact grant and play permission again. OAuth seats additionally revalidate their current connection's revocation/expiry. A newly authorized connection may represent the same durable grant; a different grant owned by the same account cannot take that seat. Names and display aliases grant no recovery authority. No OAuth consent, client registration, scope or token issuance rules are changed.

The private SQLite store owns the recovery state machine. Its process-held file lock rejects another engine using the same database. Revision-checked participant consent and a transactional compare-and-set move one match from `waiting` to `restoring`, increment its generation and issue one claim. The coordinator serializes reconstruction, validates the entire snapshot before constructing game sessions, reserves both seats, and publishes one table. Status reads cannot observe a half-reconstructed game. Failed construction removes the new table and marks the claim failed; its checkpoint is retained. A new process clears old agreements and resets dead live/restoring claims to waiting under exclusive store ownership.

The original match UUID is restored in the match object. Original table/game IDs remain in the mapping records; engine table/game IDs are newly allocated. Status supplies `originalTableId`, `originalGameId`, current `tableId`, current `gameId` and generation. Replay segments keep their real game IDs rather than rewriting prior interrupted logs. Match score/game numbering continue from the checkpoint, so interrupted segments are not counted as completed games.

Public/browser/MCP recovery responses contain only boundary metadata and mappings. They never contain the serialized snapshot, full libraries, an opponent's hand or deck, credentials or a resume ticket that could take another seat. After restoration, normal engine projections reveal each participant's own eligible information.

## Storage, engine compatibility and deployment limits

The private database is `db/pvp-recovery.db`, separate from the capture pilot. In the all-in-one image it is on the existing `/var/lib/playmat/db` volume. Database, lock and rollback-journal files are owner-only. Keep the database and its volume private; it must never enter a replay bucket, web root, support export or repository. Use a durable local filesystem with working SQLite file locks and sync semantics.

Compatibility is deliberately strict: envelope format, checksum and the exact assembled `lib`/`plugins` JAR fingerprint must match before reading a snapshot. Installed extension packages are unsupported. A different build produces an explicit **unavailable** entry and creates no table, while other compatible matches remain usable. Retain the exact previous image when updating. This does not promise arbitrary cross-version migration: drain active matches for an incompatible upgrade or return to their matching image with the preserved volume. Do not bypass the fingerprint with a version label or replay a seed to simulate the old state.

The supported topology is **one co-located product/MCP/engine replica and one private durable volume**. Claims are transactional SQLite claims, not a multi-host consensus service; do not run two replicas over copied volumes. Recovery joins are serialized within that engine. The feature adds synchronous serialization and disk-sync work and has no production latency/storage benchmark or checkpoint-row retention pruning. The all-in-one image runs the private backup daemon below when recovery is enabled. A process/container restart is covered; losing the volume is not.

The recovery guarantee covers game state and match configuration. Historical replay segments remain interrupted; cosmetics/invitation aliases and process-local telemetry are not snapshot authority. Global Career quest tallies from the interrupted process are not a durable recovery ledger. Do not use this experimental private unrated flow as a competitive result or reward-accounting migration.

## Local verification

See [recovery-verification.md](recovery-verification.md) for exact executed tests, failures and corrections, real process-restart evidence and remaining limitations. `ops/playtesting/product/recovery.local.mjs` is an opt-in isolated fixture harness; it refuses to run unless `PLAYMAT_RECOVERY_LOCAL_TEST=yes` and its database points to the dedicated `playmat-recovery-pg/recovery_fixture` fixture. `RecoveryAudit` is a test-class-only private hash helper, never a server endpoint.

## Private consistent backups

With `PLAYMAT_PVP_RECOVERY=on`, the all-in-one entrypoint also starts `recovery-backup.py daemon` after removing database and AWS credentials from child environments. It uses Python's SQLite online backup API, never a raw copy of the live file. Committed WAL pages are included and uncommitted writes are excluded. The destination is converted to a standalone rollback-journal database, integrity-checked, fsynced, then published with an atomic directory rename. The engine keeps serving while a backup reads a consistent database view.

Backups stay in `/var/lib/playmat/backups/pvp-recovery` on the existing private volume. Directories have mode 0700 and files 0600. No endpoint, replay export, S3 upload or new access grant is added. Each completed copy contains all four recovery tables (snapshots/context, reserved participants, claims and ID mappings) and a private manifest with its database checksum, source commit and exact assembled JAR fingerprint. Only the four newest completed copies are retained, at a default fifteen-minute interval. Set `PLAYMAT_RECOVERY_BACKUP_SECONDS` (60–86400) and `PLAYMAT_RECOVERY_BACKUP_KEEP` (1–96) only when needed. Failed attempts retain previous completed copies; the next exclusive backup removes abandoned partial copies. Preserved databases from explicit restores are not automatically deleted.

A daemon starts in `waiting_for_database` until recovery first creates its store, then takes a copy within five seconds. Its owner-only `status.json` records state, last successful backup time and effective interval/retention. Logs contain only generic configuration/success/failure markers, never exception details or checkpoint contents. A failed periodic attempt retries after thirty seconds and does not stop an active game. Monitor both the private status and available volume space. A permanently exited child retains the entrypoint's existing stop-all behavior; do not kill or restart it during a game.

To take a manual copy inside the running image, run `python3 /opt/playtesting/recovery-backup.py once`. It shares an exclusive backup-directory lock with the daemon. Do not download or print the resulting database or manifest in public tooling.

For restoration, stop the entire app and mount its private volume in a maintenance container running the exact compatible image. Do not start the normal entrypoint concurrently. Run `python3 /opt/playtesting/recovery-backup.py restore --saved /var/lib/playmat/backups/pvp-recovery/<selected-private-copy>` as the engine's filesystem owner. The tool validates checksum, SQLite integrity, recovery tables and exact JAR fingerprint, then acquires the same POSIX record lock as the Java store. A running engine causes rejection. Current database/journal/WAL/SHM files are preserved in a new owner-only `db/before-recovery-restore-*` directory before the validated copy is installed. Leave PostgreSQL identities/grants, the rest of the volume and replay S3 unchanged; normal current-identity authorization and both participants' fresh agreement still apply on startup.

These local copies cover an earlier consistent recovery boundary and accidental database damage within the same volume. They are not remote disaster recovery, a PostgreSQL identity backup, a retained image archive or protection against volume loss. Keep the matching image/JARs and existing product identity database separately; the manifest identifies binaries but does not contain them. No cross-database point-in-time restore or cross-build migration is promised. After any restore, verify private backup status again and never bypass snapshot compatibility or participant consent.
