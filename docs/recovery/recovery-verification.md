# PvP recovery verification

Executed locally on 2026-11-17 in the isolated `feat/durable-pvp-checkpoints` worktree. No push, deployment, production restart, production API call or real match interaction was performed. The capture-only commit `ea8d8ed6` is the base; the implementation described here includes authenticated playable recovery.

## Executed checks

| Check | Result |
| --- | --- |
| Java selected suites | CheckpointStoreTest 8, RecoveryStoreTest 1, GameSnapshotTest 6, SoloFoundationsTest 11, TrustedHeaderAuthTest 11, WebClientApiDocsTest 2, GameEventFeedTest 4: 43 tests, zero errors/failures/skips. |
| Product with dedicated PostgreSQL | 37 tests, 35 passed, 2 optional SDK/browser OAuth tests skipped, zero failed. Includes immutable account/grant identity, revocation, account disablement and current OAuth connection validation. |
| MCP current suite | 35 tests, 33 passed, 2 separately gated live suites skipped, zero failed. Ability-panel test also verifies that a duplicate START_GAME retains the same usable issued decision. |
| Browser unit tests | RecoveryScreen 2, JoinScreen 2, JoinScreen.webmcp 6 passed. |
| Browser static/build checks | TypeScript, ESLint with zero warnings allowed, Vite production build passed. Vite retains its existing warning for a bundle larger than 500 kB. |
| Actual Chromium | Participant login, explicit agreement, no automatic recoveryJoin, exactly one vote after clicking, plus original invitation → authorized stable recovery link passed. Playwright 1.61.0 Chromium desktop. |
| Actual all-in-one process loss | Dedicated product, MCP, Java and Caddy container killed together with SIGKILL and started cold against the same private volume. Browser-authenticated WebSocket participant and official MCP SDK rival recovered actual games and sideboarding. |

These are selected relevant suites, not a claim that every card, every browser or every repository suite was tested.

## Real restart fixture and observations

The dedicated Docker network is `playmat-recovery-fixture` (an unused explicit local subnet was required because the daemon's automatic pools were exhausted). Containers are `playmat-recovery-local` and `playmat-recovery-pg`; neither publishes a host port. Their volumes are `playmat-recovery-engine-data` and `playmat-recovery-pg-data`. The Maven and frontend dependency caches are dedicated copies. No unrelated container, network, volume or checkout was modified.

`ops/playtesting/product/recovery.local.mjs` provisions three synthetic human accounts and independent synthetic MCP grants through the real product layer. Its human client signs in with a cookie and crosses Caddy `/ws`; the rival uses the official SDK and public `/mcp`. A third human sends forged Alice identity headers through Caddy and is denied. A separate real grant belonging to the rival's same account is also denied. This exercises transport and authorization, not just a mocked RecoveryApi.

The seeded Modern fixture has 60 cards, a real sideboard, five-minute priority clocks, cast permanents/auras and Bomat Courier exile. At confirmed turn 9 the final fixture had 44 continuous effects and ten exiled cards. `RecoveryAudit`, a test-class-only helper with no network endpoint, independently read the private SQLite checkpoint before and after cold recovery. JSON deep equality passed for each participant's ordered library UUID hash, hand hash/count, life, saved score, sideboard hash, priority and buffer clocks, RNG next-ten-values hash, exile UUID hash/count and effect count. This compares complete library order and the RNG position; effect count is checked here, while engine snapshot tests additionally exercise round-trip game state.

Only one participant agreeing produced no playable game and no checkpoint/clock advance during the wait. Both concurrent agreements produced a single new table/generation; repeated concurrent joins reused it. Original match UUID/link and original table/game mappings survived, with newly allocated engine game/table IDs. A decision issued before the crash was rejected after recovery. Repeated START_GAME notifications preserve the current client view and decision.

Another full restart recovered the same turn, after which the browser conceded game 1. It changed its actual list by moving Mountain into the main deck and Forest into the sideboard and submitted that list while the MCP rival remained at sideboarding. After a further full restart the recovered browser list matched that submitted allocation exactly; both real sideboard prompts were confirmed again and actual game 2 reached turn 2. A subsequent restart during game 2 also recovered its turn checkpoint. Completion checks require the rival's second win, terminal recovery status and an idempotent completed-match recovery request.

An actual checkpoint from a prior local engine build was also queried on a different assembled build: it returned `unavailable` with no table allocated. Other compatible checkpoints remained listable. Never bypass the fingerprint for this test.

The final acceptance match was the synthetic `d2b2008f-c3e9-49ba-885f-88d926e25ad6`. Its final local image ID was `sha256:8c8fc3eddd265c1ea52bd5543cf34c5214b8417941f7a927eb779cf677b30bd9`. The final console evidence was:

```text
Private fixture audit recorded: phase=turn turn=9 effects=44 exiled=10
{"phase":"turn-recovered","generation":1,"turn":9,"gameNumber":1}
Exact private checkpoint comparison passed, including priority and buffer clocks
{"phase":"turn-recovered","generation":2,"turn":9,"gameNumber":1}
{"phase":"durable-sideboard","gameNumber":1}
{"phase":"sideboard-recovered-and-playing","generation":3,"gameNumber":2,"turn":2}
{"phase":"whole-match-completed","generation":3,"score":{"wins":2,"losses":0,"winsNeeded":2}}
```

The whole-match driver also independently asserted the browser's 0 wins / 2 losses, terminal `completed` recovery status and unchanged generation after a repeated recovery request. The game-2 cold restart was a separate earlier run (generation 4), not an extra stage silently included in this final three-restart transcript.

The private fixture file `/var/lib/playmat/saved/recovery-fixture.json` is owner-only and contains a test token; do not print, export or commit it. Audit JSON and the local consent screenshot stay outside version control. Full snapshots, databases, journals and credentials are absent from this commit.

## Failures found and corrected

1. The first cached fixture image had outdated Node dependencies/resources. Installing the current lockfiles and copying full MCP guide resources fixed its startup. This was fixture assembly, not a successful acceptance run.
2. An incremental Maven server build retained an old nested response-class signature after renaming it. A clean server build removed the stale class. Final assembled artifacts use the clean class set.
3. Cold snapshot deserialization required the plugin classloader to be initialized before any new game. Recovery now initializes it itself. A diagnostic warmed-process run was not counted as the cold-start acceptance.
4. The exact audit caught priority clocks being reset to the initial five minutes: ordinary Player rollback deliberately preserves current clocks. Durable recovery now explicitly restores the agreed priority and buffer values; the independent clock test and subsequent real checkpoint comparison passed. Ordinary rollback keeps its prior policy.
5. Duplicate START_GAME callbacks from repeated recovery reset the MCP client's already initialized session. The handler is now idempotent for the same game/player; its regression assertion and actual repeated reconnects cover this.
6. Closing a recovered best-of-three exposed the existing GameEndView loss field never being assigned, leaving the losing MCP-compatible client at `game_over` despite the winner reaching `match_over`. The view now computes losses from match game count, wins and draws, including restored games. A test checks independent 0–2/2–0 expectations with a draw excluded.
7. The fixture originally waited for concession without answering the other seat's pending priority. Its completion driver now advances through the real engine safe point. An initial Playwright 1.62 image mismatch was corrected to the repository's 1.61 dependency.

The first compile of the added score test passed a DeckCardLists where Match.addPlayer requires a Deck; correcting that fixture type produced the passing 43-test run. The runtime image intentionally contains Node without npm, so its suites were invoked with `node --test`. These failed setup/compile attempts are not counted as passing checks.

SQLite interruption tests are distinct from the real server restart: child-JVM tests SIGKILL a process with a 16 MB uncommitted update, then read the previous confirmed bytes in a fresh JVM and check owner-only journal permissions. They also cover file-lock exclusion, corruption/format rejection, stale writers, immutable participants, consent revision, transactional claims and boot fencing. They do not simulate disk hardware lying about fsync.

## Reproduce without production

Build the current source locally with the repository root Dockerfile, tagging it `playmat-recovery:local` (do not publish it). Use the dedicated local names below; never substitute a production database or volume. The root image contains the guarded fixture harness. For audits, run the Java test command below and copy only `Mage.Server/target/test-classes/mage/server/recovery` into `/opt/recovery-test-classes/mage/server/recovery` in the fixture container, with the same local opt-in.

```sh
docker network create playmat-recovery-fixture
docker run -d --name playmat-recovery-pg --network playmat-recovery-fixture --memory 256m \
  -v playmat-recovery-pg-data:/var/lib/postgresql/data \
  -e POSTGRES_USER=playmat -e POSTGRES_DB=recovery_fixture \
  -e POSTGRES_PASSWORD=isolated-local-fixture postgres:17
docker run -d --name playmat-recovery-local --network playmat-recovery-fixture --memory 2g \
  -v playmat-recovery-engine-data:/var/lib/playmat \
  -e DATABASE_URL=postgresql://playmat:isolated-local-fixture@playmat-recovery-pg:5432/recovery_fixture \
  -e PLAYMAT_PUBLIC_URL=http://127.0.0.1:8080 -e PLAYMAT_INSECURE_COOKIE=true \
  -e PLAYMAT_PVP_RECOVERY=on -e PLAYMAT_RECOVERY_LOCAL_TEST=yes -e XMAGE_MEMORY=1024m \
  -e XMAGE_JAVA_OPTS=-Dh2.bindAddress=127.0.0.1 playmat-recovery:local
```

Wait for the local `/healthz` inside that container before every harness command. `prepare` returns only a synthetic match UUID and stable link. Perform each kill promptly after the preceding fixture stage; live decisions use normal five-minute match clocks and sideboarding has its normal three-minute window.

```sh
docker exec --user xmage -w /opt/xmage playmat-recovery-local node /opt/playtesting/product/recovery.local.mjs prepare
# Optionally record private RecoveryAudit hashes here.
docker kill --signal KILL playmat-recovery-local
docker start playmat-recovery-local
# Wait for local health; optionally run the Chromium consent test here.
docker exec --user xmage -w /opt/xmage playmat-recovery-local node /opt/playtesting/product/recovery.local.mjs recover
# Compare the same private audit fields; then repeat a full cold restart.
docker kill --signal KILL playmat-recovery-local
docker start playmat-recovery-local
# Wait for local health.
docker exec --user xmage -w /opt/xmage playmat-recovery-local node /opt/playtesting/product/recovery.local.mjs recover-sideboard
docker kill --signal KILL playmat-recovery-local
docker start playmat-recovery-local
# Wait for local health; this recovers sideboarding, plays game 2 and verifies completion.
docker exec --user xmage -w /opt/xmage playmat-recovery-local node /opt/playtesting/product/recovery.local.mjs recover
```

Chromium uses `MAGE_WEB_E2E_BASE_URL=http://playmat-recovery-local:8080`, `PLAYMAT_RECOVERY_UI_LOCAL=yes`, `PLAYMAT_RECOVERY_UI_MATCH=<printed UUID>`, and optional `PLAYMAT_RECOVERY_UI_ORIGINAL_TABLE=<original table UUID>`, with `e2e/recovery.local.spec.ts --project=chromium-desktop --workers=1` in a Playwright 1.61 container on the fixture network. It accepts just the human's vote; the real MCP still has to agree.

Java verification was run with Maven 3.9 / Temurin 17 in Docker, dedicated Maven cache, localhost hostname, and:

```sh
mvn -o -B -q -pl 'Mage.Server,Mage.Tests,!Mage.Sets' -am test \
  -Dtest=CheckpointStoreTest,RecoveryStoreTest,GameSnapshotTest,WebClientApiDocsTest,TrustedHeaderAuthTest,SoloFoundationsTest,GameEventFeedTest \
  -Dsurefire.failIfNoSpecifiedTests=false \
  '-DargLine=-Dfile.encoding=UTF-8 -Dh2.bindAddress=127.0.0.1'
```

Product tests require `PLAYMAT_TEST_DATABASE_URL` pointing only to the fixture PostgreSQL, then `node --test`; MCP uses `node --test test/*.test.mjs`. Frontend commands are `npm run typecheck`, `npm run lint`, focused Vitest files in the table above, and `npm run build`. All dependency/build/runtime commands used Docker. Offline Maven required resolving missing public dependencies into the dedicated cache first; this does not imply a clean machine has those dependencies offline.

## Integration and limits

Keep the feature off unless explicitly opting new eligible private unrated matches in. The active pre-existing production match has no retroactive checkpoint and must finish before any incompatible engine replacement. Preserve the previous exact image and private durable volume. Integrate the independent clock contract commit `bd769a450eace3f8c004016f2ffbcb6fe091573d`, preserving its `seatTiming` and unknown-response-deadline fields; this branch does not infer unlimited time from null or alter OAuth rules.

The supported topology is one co-located replica with SQLite on one durable local filesystem. Multi-replica recovery, cross-version migration, remote volume-loss recovery, retention pruning, production latency/storage benchmarking and a new private backup policy remain outside this implementation. Global Career/reward bookkeeping and reconstruction of old interrupted replay segments are also outside its guarantee. These are explicit boundaries, not unimplemented playable-turn/sideboard recovery endpoints. See [pvp-recovery.md](pvp-recovery.md).
