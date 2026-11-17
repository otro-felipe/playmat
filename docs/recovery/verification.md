# Capture pilot verification — 2026-11-17

Scope: isolated local worktree `feat/durable-pvp-checkpoints`, based on `1f0b1edf2d72aad264ce56a1746654507c8a6d3c`. No deployment, push, production restart, real match interaction or other computer was used.

All dependency/build/test commands ran in `maven:3.9-eclipse-temurin-17` containers. An existing dependency cache was mounted read-only once and copied into the dedicated `playmat-recovery-maven` volume; no existing application container or data volume was used. The source mount was this worktree. Tests expose no ports and use fixture-only temporary SQLite files. Final affected-suite runs used `--network none --hostname localhost`.

| Verification | Result |
| --- | --- |
| Maven offline `test-compile`, `-pl 'Mage.Server,!Mage.Sets' -am` | Passed |
| `CheckpointStoreTest` final source | 8 tests, 0 failures, 0 errors, 0 skipped |
| `SoloFoundationsTest` after final source changes | 11 tests, 0 failures, 0 errors, 0 skipped |
| Existing `GameSnapshotTest` | 4 tests, 0 failures, 0 errors, 0 skipped; unchanged core snapshot code |
| `git diff --check` | Passed |

The first offline server-suite run failed because H2's AUTO_SERVER could not resolve the container hostname. Binding H2 to `127.0.0.1` and setting the container hostname to localhost resolved this. The initial human fixture also failed its watcher assertion: the fixture tried adding a new watcher where a default watcher already existed. The fixture now sets the existing watcher's state and verifies it independently after serialization and a fresh JVM read. No engine watcher code was changed.

The first combined offline run could not resolve `net.java.truevfs:truevfs-profile-base:0.14.0` for `Mage.Tests`. A subsequent isolated container run with public Maven dependency resolution enabled downloaded missing test dependencies and passed `GameSnapshotTest`. Later affected-server-suite runs were offline again. No project dependencies were installed on the host.

The documented server command is in [pvp-checkpoints.md](pvp-checkpoints.md#local-verification-only). To include the existing snapshot suite once its dependencies are cached, change the project list to `-pl 'Mage.Server,Mage.Tests,!Mage.Sets'` and test selection to `-Dtest=CheckpointStoreTest,SoloFoundationsTest,GameSnapshotTest`. Surefire XML evidence is in the worktree's ignored `Mage.Server/target/surefire-reports/` and `Mage.Tests/target/surefire-reports/`; no payloads/databases are committed.

The crash tests terminate real child JVMs forcibly. One child commits a fixture with two actual `HumanPlayer` seats, then is killed; another JVM verifies library order, private hands, exile, continuous effect, watcher count, RNG continuation, score, sideboard lists, options and priority/buffer clocks. Another child updates both payloads in a transaction, retains its open connection and on-disk owner-only rollback journal, and is killed before commit. Reopening preserves the previous turn, revision and both byte arrays. Store ownership is rejected while another JVM has the lock.

Not executed or delivered: a live two-client browser/MCP game reconnecting after a full server restart, stable recovery links/routes, account/grant-based seat authorization, recovery claims/fencing, an unrelated client's restore denial, simultaneous/repeated player reconnection, sideboarding/next-game restoration, resumed ticking clocks, restored trigger execution, cross-build migration, or production latency/disk benchmarks. No endpoint exists to exercise those flows yet. The private capture flag does not make any of them available. Frontend lint/typecheck was not run because no frontend application code changed.
