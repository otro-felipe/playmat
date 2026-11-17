# Integrated candidate — 2026-11-17

Worktree: `playmat-one-shot`, branch `main`.

The finished branch through `24db7541` was subsequently integrated into a new `main` by fast-forward from the existing `origin/master` ancestor. No conflicting history was overwritten, and `master` remains the repository's default branch. The finished PvP recovery commits were subsequently cherry-picked as `98195a0825b` and `6b269ec7373`, preserving the later OAuth, timing, trigger, sequence and guide changes. Deployment remains gated on independent security review, private backup readiness and a fresh zero-active-games check.

- Base `ccdfe6807c4d195bfaccb7968d7a88d4589b570f`: Freeform drafts and independent deck updates preserved.
- `6ccc55ca`: MCP guide bootstrap, turn-boundary protection and explicit rollback votes.
- `0af681cb`: cherry-pick of OAuth client registry `19f8176fba13d27de707beff3e9abceca413e5b5`.
- The turn-planning guide also documents spell/payment batching, an explicit pass followed by opponent priority, bounded holds and their actual limitations.
- The final cast-zone patch permits a currently legal visible spell from hand, exile or graveyard, including another player's public zone. It preserves the selected physical card, casting controller and stack checks. Eight new regressions cover supported zones and rejected non-cast expectations.
- Follow-up `e1145119` preserves legal selection across every public battlefield, with six regressions covering opposing targets, duplicate names, exact card IDs, illegal objects and hand isolation.
- Conditional-line integration adds deliberate standalone passing, `yield_priority`, opt-in expected-spell resolutions, empty-stack conditions and conservative public-opponent interruption guards. Opponent waits pause the active budget within a fifteen-minute wall limit. Restart persistence and PvP game recovery are not included.

## Local verification

All project commands ran in Docker on the personal MacBook Pro. No production credentials or game actions were used in tests.

| Check | Result |
| --- | --- |
| Product suite with disposable PostgreSQL 17, official MCP SDK and Chromium enabled | 35 passed, 0 skipped |
| MCP build and full fixture suite after conditional lines and selector integration | 62 passed, 2 live tests skipped |
| MCP core rebuild and full suite after opponent-range guide and decision-timing integration | 65 passed, 3 opt-in live tests skipped |
| MCP core rebuild and full suite after planned-trigger integration | 78 passed, 3 opt-in live tests skipped |
| Planned-trigger Java/controller integration | Offline `mvn -o -B -pl Mage.Common -am -DskipTests compile` and `package`: BUILD SUCCESS; updated local `mage`/`mage-common` JARs produced, Java tests skipped; frontend `tsc -b` and ESLint for `agentChoices.ts` passed |
| Independent two-spell regression | Passed: exact mana-source selection, separate source taps, both expected resolutions, final end step in the same turn |
| Frontend build with private-playtesting flags | Passed; existing large-chunk warning |
| Modal, invitation bootstrap and deck-sync component/store regressions | 7 passed |
| Chromium rollback UI fixture | 2 passed: Escape, outside mouse/touch, focus, both votes and queued requests |
| TypeScript, accessibility coverage and ESLint for affected UI/tests | Passed |
| Integrated Caddy configuration including `/oauth/register` | Valid |
| `git diff --check` | Passed |

The final checks on `main` rebuilt the MCP core and passed 62 MCP tests (two live tests skipped), 1,529 frontend tests (42 skipped), accessibility coverage, TypeScript and ESLint for the final correction. Three portrait-layout assertions still reserved central space for the former phase ladder. They now check separation of the battlefield rows, with a separate component assertion requiring the phase navigation inside the decision region. Runtime layout behavior was not changed.

The later opponent-range guide passed eight HTTP MCP acceptance cases, including delivery through `get_guide` and resource parity. Decision-timing integration preserved those cases and passed the expanded 65-test MCP suite. It reports cumulative match-clock samples separately from unknown inactivity timing, preserves zero and keeps pending decisions visible after wait timeouts. It does not implement an authoritative inactivity deadline, game persistence or recovery; see [the timing evidence](../../mcp-decision-timing.md) for that boundary and the author's separate local-engine test.

Planned-trigger integration preserved all clock and range-guide changes. Tests cover exact own-trigger matching, simultaneous spell/trigger stack updates, prompt guards before stack arrival, rejected opponent/extra/ambiguous triggers, illegal targets, hidden-source redaction and interruption despite a successful final action acknowledgement. The future deployment must rebuild the engine distribution/JAR containing `StackAbilityView` as well as the MCP core; clients must refresh schemas. This is not a deployment or recovery acceptance result, and an instruction string alone is not causal proof of a trigger.

## Publication status

The existing Railway project is `playmat-playtesting` (`e1ad2c1e-17af-43f4-9721-38ee15e8d4a4`), environment `production` (`c52e5660-847a-417a-b624-e983205e8295`), service `playmat` (`cdb36263-f818-4f1e-8653-76028e74c624`). Its source has no connected GitHub repository. The current successful deployment observed was `f0849069-cb48-46c6-87d9-e9cf69a72261`, running `ccdfe6807c4d195bfaccb7968d7a88d4589b570f`.

The public `/healthz` check returned healthy with two active/running games. OAuth discovery still lacked `registration_endpoint`, consistent with the previous production build. No candidate component has been applied to production.

The entrypoint starts product, XMage, MCP and Caddy under one parent. It exits after any child exits and then terminates all children. A full deploy or an individual child restart would interrupt the running engine. SSH inspection could not proceed because Railway reported no registered SSH keys. No key or account setting was changed. Deployment is therefore deferred until active games are finished or a separately approved, verified nondisruptive path exists. The frontend artifact is built locally; it has not been uploaded. A browser refresh alone currently provides no new fixes.

Source publication was initially blocked: automatic approval review rejected `git push origin feat/private-playtesting` to the public `otro-felipe/playmat` fork, requiring explicit destination authorization. Neither rejected attempt executed. The owner subsequently approved that exact destination and branch, with the requirement to exclude all secrets. The final outgoing commit history and file snapshots must pass the secret/sensitive-data review before the authorized push; verify the remote branch hash afterward.

After the blockers are resolved, publish the branch, deploy the integrated candidate to the exact Railway service above, observe terminal `SUCCESS`, then verify effective commit, health, OAuth registration metadata and frontend assets. Do not claim deployment success from an upload or queued build. OAuth client support and remaining per-client acceptance limits are detailed in [OAuth verification](oauth-verification.md).

## Main publication safety check

Before the `main` push, Railway's current service source had `repo: null`, and the successful deployment still identified `ccdfe680`. GitHub returned no configured repository webhooks and zero registered workflows. The checked-in production deployment workflow responds only to release publication or manual dispatch; push workflows accepting `main` run tests. The `master`-only image/site workflows are not triggered by creating `main`. No deploy source, default branch, hook, workflow or service setting was changed. Publishing `main` does not initiate a Railway deployment under this inspected configuration.

## Combined recovery candidate verification

The root Dockerfile built the complete combined image locally with engine/JARs, MCP core, frontend, product and Caddy. Its source stamp was `6b269ec7373`. Build output remains local; no production settings or processes were changed.

| Check | Result |
| --- | --- |
| Clean Java selected recovery, identity, snapshot, event and API suites | 43 passed, zero failures/errors/skips |
| Product with isolated PostgreSQL, official MCP SDK and Chromium OAuth | 37 passed, zero skipped |
| Rebuilt MCP core and complete fixture suite | 78 passed, 3 opt-in live suites skipped |
| Recovery/invitation component tests, TypeScript and affected-screen ESLint | 10 passed; static checks passed |
| Full assembled image cold-restart acceptance | Three SIGKILLs and cold starts passed: turn 9 → restored turn 9 → restored turn 9 and actual modified sideboard → restored sideboard, game 2 and terminal 2–0 match |
| Independent private checkpoint equality | Passed for ordered libraries, hands, RNG, exile, effects, score, sideboard and priority/buffer clocks |
| Chromium on the combined image | 1 passed: original invitation → stable recovery link, no automatic vote, exactly one explicit agreement |

The first Chromium invocation used the match UUID where the fixture required its distinct original-table UUID; it failed before reaching recovery, then passed with the actual fixture metadata. The first offline Java clean command lacked a cached clean plugin; the online clean run resolved public dependencies and produced the passing reports. Docker's environment-name lint warnings do not represent embedded credentials. The fixture uses dedicated local containers, private volumes, synthetic accounts and a network without host-published ports. No real game was queried or modified by the fixture. Private checkpoint files, tokens, hashes and screenshots remain untracked.

The production read-only check during this integration still returned effective commit `ccdfe6807c4d195bfaccb7968d7a88d4589b570f`, healthy with one active/running game. Railway still showed successful deployment `f0849069-cb48-46c6-87d9-e9cf69a72261`, one replica, no connected source repository and the existing private `/var/lib/playmat` volume. OAuth discovery still lacked the new registration endpoint. No integrated fixes are claimed to be deployed.

Before enabling `PLAYMAT_PVP_RECOVERY=on`, resolve the private consistent SQLite backup prerequisite in [the recovery operations contract](../../recovery/pvp-recovery.md). The existing backup script does not include `pvp-recovery.db`, and no suitable production backup configuration has been verified. A persistent volume alone does not establish a backup. Independent security approval and zero active games immediately before the full-image replacement are separate mandatory gates.

After those gates pass, preserve the existing database, volume and private S3 replay configuration; use the single-replica topology, deploy the complete image with the final source stamp, await terminal Railway `SUCCESS`, then verify effective commit, health, OAuth discovery/registration, guide delivery and actual recovery configuration. Never place snapshots in the replay bucket or simulate a production crash. Recovery covers only newly opted-in eligible private unrated two-participant Java matches on the same exact compatible image; it does not recover old matches, cross builds or a lost volume. Queued MCP lines and authoritative inactivity deadlines remain outside its persistence contract.

## Private-backup follow-up — not yet publishable

The independent recovery security review was approved without blocking findings in authorization, privacy, claims or supported limits. That was a static review, not a new process-restart acceptance run; the combined-image three-SIGKILL result above remains the separate executed runtime evidence.

A follow-up now adds `ops/playtesting/recovery-backup.py`, its isolated Python tests, the runtime Python package and conditional daemon startup. The intended policy is online SQLite backup, owner-only local files, four consistent copies every fifteen minutes, checksummed exact-JAR manifests, exclusive maintenance locking and offline restoration preserving prior database artifacts. No snapshot upload, access expansion or production change has occurred.

Six initial Docker unit cases passed after fixing a regression where a destination database inherited WAL mode. They exercised committed/uncommitted WAL contents, all recovery tables, integrity, file modes, retention, incompatible/tampered input, symlink rejection, sanitized errors and a separate-process POSIX lock. Later changes add exclusive backup ownership, abandoned-partial cleanup and a seventh daemon/status test; the final rerun and actual Java-lock/assembled-image backup restoration are still pending.

The full-image rebuild failed with Docker storage E/S errors after the host disk filled. Five old Railway staging exports were removed only after every regular file's Git blob was verified to exist in this repository (zero missing blobs and zero symlinks); no worktree, source, database or test volume was deleted. This freed about six GiB. With all local containers stopped, a local Docker Desktop restart was attempted, but the daemon still timed out on a bounded `_ping`. No factory reset, volume deletion, image/cache prune or filesystem repair was attempted. Final tests, image acceptance and the final secret scan cannot be claimed complete for the uncommitted backup follow-up.

The latest read-only production sample was healthy at `ccdfe6807c4d195bfaccb7968d7a88d4589b570f` with zero active/running games. This is a sample, not permission to skip the immediate pre-deploy check. Public main remains `0fdde3ab7e1adaeaff8e643d1b38a6a725919cf1`; the backup follow-up has not been committed, pushed or deployed. Restore local Docker safely, rerun the expanded unit suite and combined-image backup/restore acceptance (including rejection under the real Java FileChannel lock), repeat publication scanning, then publish before considering a fresh zero-game production deployment.

## Native fallback and isolated CI acceptance

With the explicit instruction to continue using available native tools while Docker is unavailable, the expanded backup suite passed eight tests on the personal MacBook Pro using installed Python/SQLite and OpenJDK 17. The actual compiled production `CheckpointStore` opened a private synthetic database in a separate JVM: restoration failed under its Java FileChannel lock, preserved the database, then succeeded after that JVM released ownership. Public dependencies matched the repository's pinned SQLite JDBC 3.53.2.0 and SLF4J API 2.0.17 coordinates and were staged only in a private temporary fixture; no host package installation or product dependency change was made.

The local Docker VM completed shutdown but the Desktop backend remained stopped/unresponsive after standard application reopening and SIGTERM to the identified backend. Only this task had a waiting Docker test command; other listed project tasks were idle and no active Docker container/build was found. No force kill, reset, prune, security change or private-volume deletion was used.

The public repository already has GitHub Actions enabled. The new `Private recovery image acceptance` workflow uses read-only repository permission, no persisted checkout credentials, no secrets, no deployment step and no private fixture artifact upload. Its explicit opt-in script builds the whole image and uses newly named Docker networks/volumes with no host-published ports. It checks private modes and the manifest fingerprint against Java's actual stored checkpoint fingerprint, rejects restoration under the running game engine, damages only its own synthetic closed database, restores all four tables exactly while retaining the prior database, then recovers turn 9, changed sideboarding and game 2 to terminal 2–0 through real cold restarts. Its effective daemon status must also show a successful private backup. Synthetic data stays inside that isolated runner; no production variable, database or game is used. The workflow is a pending acceptance check until its terminal result is observed.

## Final backup acceptance

The latest runtime source `0fa4b316` passed [complete Linux image acceptance](https://github.com/otro-felipe/playmat/actions/runs/44158811900). The full Java reactor at `a3506582` (identical final runtime Java sources) also passed: 8,221 registered tests, zero failures/errors and 151 declared skips. The native backup suite passed ten tests, including the actual compiled Java store lock. Linux image units passed nine with one optional compiled-helper skip; the actual running engine lock and restore were mandatory acceptance checks and passed independently. See [the consolidated backup evidence](../../recovery/backup-verification.md) for exact outcomes, failures corrected before rollout, privacy and remaining limits. New mobile mana/Autopay work is excluded from this release.

All gates for source validation and independent static review are satisfied. Production rollout remains a separate action requiring an immediate zero-active-games check, the full image with the final source stamp, one replica and the existing PostgreSQL/private volume/S3 preserved. Do not interpret prior healthy/build/source-push checks as a completed deployment.
