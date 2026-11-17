# Private recovery backup verification — 2026-11-17

This follow-up integrates consistent private backups with the completed PvP recovery feature. The full release `a91940d78ba00db8539c8eed291db0b5d5ab5c44` subsequently reached Railway deployment `fa7b15ae-2e4d-4116-a601-2d8b0dd5682c` with terminal `SUCCESS` after a fresh zero-game check. Public health reported the exact source hash. Actual runtime logs confirmed recovery backups configured at 900 seconds/four copies and a completed private backup on the retained persistent volume. Recovery is enabled within the scope below. No production crash or restore was simulated. Private backup-directory inspection requires an unavailable registered Railway SSH key; no key or access permission was added, and private status-file contents are not claimed as inspected.

## Executed validation

| Check | Observed result |
| --- | --- |
| Native isolated backup suite on the personal MacBook Pro | 10 passed, zero skipped, including a separate JVM running the actual compiled production `CheckpointStore` |
| Full Java Maven reactor, runtime Java source through `a3506582` | [BUILD SUCCESS](https://github.com/otro-felipe/playmat/actions/runs/44158130278); 8,221 registered tests across module summaries, zero failures/errors, 151 declared skips |
| Complete Linux image, `a3506582` | [Acceptance passed](https://github.com/otro-felipe/playmat/actions/runs/44158130167), image `sha256:8ec75a2622bf7c09fccfcc5618fd63f438fe903139273cccc8652c7155ff8b35` |
| Backup tests inside that image | Eight passed; one separate compiled-Java helper case skipped because the runtime intentionally contains a JRE. The actual live Java engine lock was independently exercised below |
| MCP suite inside that image | 78 passed, three opt-in live suites skipped |
| Final missing-mount hardening, `0fa4b316` | [Full-image rerun passed](https://github.com/otro-felipe/playmat/actions/runs/44158811900), terminal SUCCESS; nine backup unit tests passed, one separate JRE-only helper skipped, with the real live Java lock checked by mandatory image acceptance |
| Combined mobile, stack/history and production minifier candidate, `086af8319db` | [Full-image rerun passed](https://github.com/otro-felipe/playmat/actions/runs/44168444838), terminal SUCCESS; mandatory real-engine lock rejection, exact four-table offline restore, private prior-database retention, three cold restarts, changed sideboarding, game 2, terminal 2–0 and effective private daemon policy |

Native validation used installed Python 3.14.5, SQLite 3.53.4 and OpenJDK 17.0.17. The JVM fixture used the repository-pinned public SQLite JDBC 3.53.2.0 and SLF4J API 2.0.17 artifacts staged in a private temporary directory; no host package installation was required. Docker became unavailable after host disk exhaustion, so a fresh GitHub-hosted Linux runner supplied actual image validation without production secrets or data.

The successful image run constructed JARs, MCP core, frontend, product and Caddy with the root Dockerfile, using fresh isolated PostgreSQL and engine volumes, no host-published ports, and synthetic accounts/grants. It reached a real confirmed turn 9. The Python manifest fingerprint equaled the fingerprint stored by Java in the actual checkpoint. Restoration under the running game process's Java FileChannel lock was rejected; all private directories/files had modes 0700/0600.

After SIGKILL, a networkless maintenance container using the exact same image deliberately damaged only its synthetic current database. Offline restoration then matched every row in all four recovery tables exactly against the consistent backup, including the full context and snapshot blobs, reserved identities, claims and ID mappings. The previous damaged database remained private and unchanged in its preservation directory. SQLite integrity verification passed.

The app then started cold and recovered turn 9 after both authenticated participants explicitly agreed. Two more complete SIGKILL/start cycles recovered turn 9 and an actually changed submitted sideboard allocation, played game 2, and finished the encounter 2–0 with terminal/idempotent recovery status. The actual daemon's owner-only status reported successful backups with the fixture's explicit 60-second interval and retention of two. Production defaults remain fifteen minutes and four completed copies.

The original component areas remain covered by earlier integrated verification: product/OAuth with PostgreSQL, official SDK and Chromium (37 passed), focused browser tests (10 passed), actual Chromium recovery agreement/invitation acceptance, guide delivery, timing, trigger and sequence guards. This follow-up does not claim a new login test for every branded MCP client.

## Regressions found before rollout

- A destination could inherit WAL mode. The backup now explicitly produces a standalone rollback-journal database; tests prove inclusion of committed WAL pages and exclusion of live uncommitted writes.
- Restoration fsync initially rejected the image's intentional database-directory symlink. A regression failed before the fix and passed afterward; the configured directory is resolved while individual data/lock/backup files still reject symlinks.
- A maintenance container missing its volume link could otherwise create an ephemeral database. Restoration now requires the existing mounted directory, with a negative test proving no new destination is created.
- General Java CI exposed an unconditional manager lookup in recovery identity binding for bridge-only login contexts. Real managed sessions retain principal binding/clearing; bridge contexts without user objects no longer throw. The RPC contract fixture now offers a valid expected prompt and independently rejects replay before server dispatch. Recovery coordinator methods are classified separately from direct `MageServer` forwarding methods. The full reactor passed after these changes.
- Initial isolated startup failed before PostgreSQL was ready. A second diagnostic run established exit 1 with `oom=false`; the fixture now waits for final PostgreSQL TCP readiness. Exit 137 alone was not treated as proof of OOM. Earlier failed/cancelled runs are not counted as successful acceptance.

## Privacy, operations and limits

Read [the exact backup and offline restore procedure](pvp-recovery.md#private-consistent-backups). The daemon uses SQLite's online backup API, fsync and atomic publication, with exclusive backup-directory ownership and bounded completed-copy retention. It runs without the product database/AWS credentials and has no network upload or participant-facing snapshot endpoint. Logs and CI output contain generic markers and synthetic metadata, never serialized checkpoints or actual user credentials; private fixture files are not uploaded as artifacts.

These are same-volume copies and same-image recovery. They do not preserve a lost volume, archive the image binaries, back up PostgreSQL identities, reconstruct past replay segments or migrate snapshots across incompatible builds. Keep the product identities/grants, private volume and matching image intact. Current authorization and fresh participant agreement remain mandatory after an offline restore. New eligible private unrated two-participant Java matches are supported; old unprotected games cannot be recovered retroactively.

The independent recovery security review was approved without blocking findings in authorization, privacy, claims and supported limits. It was a static review, distinct from the executed native and Linux process-restart checks above. The subsequent mobile mana/Autopay and stack/history candidate is separate from this already deployed recovery release and must pass its own final checks before replacement.
