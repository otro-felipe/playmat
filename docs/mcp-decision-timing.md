# MCP decision timing

## Current response-idle contract (candidate; runtime validation pending)

The server now exposes the receiving player's actual pending response-idle timer as `GameView.responseIdle`: `status`, `deadlineEpochMs`, `sampledAtEpochMs`, `remainingMillis` and `timeoutSeconds`. The sample comes from the scheduler's remaining delay, not the cumulative match clock or a client receipt timestamp. Zero remains zero. Watcher views contain no such private timer; another player's view cannot read the recipient's pending deadline. Older engines still produce `timing.inactivity.status: "unknown"` with null values.

Authenticated private unrated matches with exactly two human engine players, two seated users and two distinct product-bound principals receive a **900-second (15-minute)** response window. MCP seats use the human engine implementation. The scope requires the private product gateway, no spectators and no tournament/subtable. `PLAYMAT_PRIVATE_RESPONSE_IDLE_SECONDS` can explicitly select 60–3600 seconds for that scope; missing, blank or invalid values use 900. Ordinary/public/ranked/spectated/AI/multiplayer configurations continue using their existing runtime/config/test-mode timeout. The cumulative priority/match clock is unchanged, so a shorter enabled match clock can still expire first.

A new actual engine prompt arms the timer. An accepted current seat/controller response cancels it; the next prompt receives a fresh window. The starting-player fallback does not rearm a prompt that is already timed. Reads, chat, notifications and `gameResync` do not arm, cancel or extend a timer. A generation token fences cancelled scheduler callbacks and queued expiry actions. Expiry is applied on the game thread rather than calling into the game while holding the timer lock.

Cached prompt/state resends preserve the same absolute deadline and resample server time/remaining milliseconds before transmission. Their stored state-patch baseline uses the same refreshed metadata. Replaying an answered state cannot manufacture an active timer. The browser uses fresh server remaining-time samples and monotonic elapsed time, so a skewed client wall clock or an identical replay does not replenish its countdown. Transport delay can make the display approximate; the engine scheduler is authoritative. MCP runs beside the engine and reports `timing.inactivity` independently of `timing.matchClock`, with a pending-decision warning. A null top-level `secondsRemaining` never disables inactivity.

Idle windows are not persisted as match-clock balances. Recovery still requires the matching assembled JAR fingerprint, preserved private volume and both original participants' fresh agreement. A replacement game's new prompt starts its response window; agreement/downtime does not consume a match clock. This change builds a new engine JAR and does not promise recovery of an older incompatible image's snapshots.

### Verification prepared for CI

- Java `PrivateMatchIdlePolicyTest`: actual ranked/spectator/tournament/human-count options, private default/config bounds and public fallback.
- Java `ResponseIdleTimerTest`: scheduler delay/deadline, zero, reads that cannot renew, own-seat isolation, accepted-response cancellation, next-prompt window and stale-generation rejection.
- Java `ResponseIdleClockTest`: cached deadline resampling and clearing answered state metadata.
- MCP HTTP plus synthetic WebSocket timing cases: disabled match clock with a real own idle deadline, preserved zero, no actions during polling and inactive/disabled/foreign-seat handling.
- Frontend pure/component cases: monotonic countdown, client wall-clock skew, duplicate sample, urgent zero and unknown states. Chromium EN/ES fixtures leave manual mobile controls usable.
- Complete-image isolated acceptance adds a new private untimed match after the existing recovery encounter. With the deliberately configured minimum 60-second idle policy, it observes an accepted response create a fresh deadline, then continuously reads and resends the next cached prompt until the actual idle auto-concede and game-over callbacks. Production is never used for this test.

The candidate's dependency/framework tests have not run on the host: Docker is unavailable. Only `git diff --check`, JavaScript syntax-only checks and shell syntax checks ran before handoff. The integrator must record actual CI outcomes before describing these gates as passed.

## Historical investigation before this engine contract

The original adapter-only investigation and its executed evidence follow. Its statements about an unexposed inactivity deadline describe the earlier build, not the new contract above.


## Finding

A reported human/MCP game ended in inactivity while the agent saw `secondsRemaining: null`. This checkout confirms that field never represented the response-inactivity timeout. The incident itself was not replayed against a production game.

- `Mage/src/main/java/mage/game/match/MatchImpl.java`, `initGame`, initializes the player's cumulative match priority budget and carries it between games. `Mage.Server/src/main/java/mage/server/game/GameController.java`, `createPlayerTimer` and `updatePriorityTimers`, maintains that clock. `Mage.Common/src/main/java/mage/view/PlayerView.java` serializes the balance and timer activity.
- The former MCP expression in `ops/playtesting/mcp/src/engine-seat.mjs` returned a balance only when `timerActive` was true and `priorityTimeLeftSecs > 0`. Paused, zero, disabled and unavailable clocks all collapsed to null. It did not consult `GameView.priorityTime` to distinguish a disabled match clock.
- `GameController` enables `useResponseIdleTimeout` when more than one human engine player participates. MCP seats are human engine players. `perform` starts/restarts the response timeout before sending a prompt, and `sendMessage` cancels it on an accepted seat/controller action. `startChoosingPlayerIdleTimeout` also covers the starting-player choice. `onResponseIdleTimeout` calls `game.idleTimeout` and announces an auto-concede.
- The authoritative pending delay lives in `responseIdleTimeoutFuture`. `getResponseIdleTimeoutSecs` reads runtime/config settings (or a test-mode override). No deadline or remaining delay is serialized in the current game/prompt views. The scheduler delay appears only in server diagnostic/fix code. Receiving a prompt, polling, chatting or receiving a webhook cannot establish the original deadline.

The evidence explains why null cannot establish safety; it does not establish the incident's exact remaining time or deployed settings.

## Adapter contract

`timing.matchClock` reports `running`, `paused`, `disabled` or `unknown`, plus `lastReportedSecondsRemaining` and `reportedAtEpochMs` when available. These are server samples, with no local extrapolation or claim that they are current. `GameView.priorityTime: 0` identifies a disabled match clock. A missing configuration stays unknown. A valid zero balance is preserved. The legacy top-level `secondsRemaining` is the sampled balance only while that clock is running.

`timing.inactivity` explicitly reports `status: "unknown"`, `deadlineEpochMs: null` and `secondsRemaining: null`. Null never means unlimited decision time. A visible legal decision carries `timing.warning`. A wait timeout returns the current state, including an already observed unanswered decision. Reads, warnings and waits never select or submit a game action.

The initialization instructions, tool descriptions and getting-started/turn-planning guides explain the distinction and keep the model responsible for the active decision loop. The hold cap still only bounds an intentional pause; it does not guarantee safety against an unexposed inactivity deadline.

## Future engine work requiring coordination

No Java, persistence or recovery code is changed here. Exposing an authoritative deadline requires coordinated changes around `GameController.startResponseIdleTimeout`/`stopResponseIdleTimeout` and the game/prompt serialization path, with the affected player, enabled/active state, scheduler deadline and reset/cancellation semantics. Candidate files to coordinate are `Mage.Server/src/main/java/mage/server/game/GameController.java`, the callback/view builders in `GameSessionPlayer.java`, `Mage.Common/src/main/java/mage/view/GameView.java` (or a dedicated callback timing contract) and generated client protocol types. Include callbacks that do not carry a `GameClientMessage`, such as ability selection. Resync must carry the existing deadline rather than creating a new one. Runtime settings alone or a client receipt timestamp are insufficient. Coordinate that contract with the recovery work before implementing it.

## Local verification

`ops/playtesting/mcp/test/decision-timing.test.mjs` uses the real built client core, a synthetic loopback WebSocket engine and real MCP HTTP transport. It checks running/paused/zero/disabled/missing clock signals, unknown inactivity, a pending mulligan surviving a wait timeout, no automatic actions, an explicit guarded answer and removal of the warning on game end. No production account or game is used. Build the core before running the tests; generated `dist` and `node_modules` stay outside the patch.

`test/decision-timing.live.test.mjs` is opt-in and accepts only the hardcoded loopback engine. It creates two synthetic human seats and deliberately leaves its fixture prompt unanswered. Run it in a disposable engine's network namespace, with no published ports or data volumes. The engine-only image needs product integration disabled and a three-second idle setting. For example, after `npm ci` and `npm run build` in the Node 22 container:

```sh
docker run -d --name playmat-decision-clock-fixture --hostname localhost \
  --network none --memory 2g --cpus 2 \
  -e PLAYMAT_PRIVATE_BETA=false -e XMAGE_MAX_SECONDS_IDLE=3 \
  -e XMAGE_MEMORY=768m -e XMAGE_GATEWAY=off \
  --entrypoint /bin/sh playmat-oneshot-dev:local \
  -c 'mkdir -p db cards-db saved/replays logs && exec /usr/local/bin/xmage-server'
docker run --rm --network container:playmat-decision-clock-fixture \
  -v "$PWD:/source" -w /source/ops/playtesting/mcp \
  -e PLAYMAT_LOCAL_TIMING_FIXTURE=1 node:22-bookworm-slim \
  node --test test/decision-timing.live.test.mjs
docker rm -f playmat-decision-clock-fixture
```

Run from the repository root. This local engine check passed on 2026-11-17 with the candidate adapter/core and the installed `playmat-oneshot-dev:local` image `sha256:10e87fd156d0670c4eac35ff4d626187f867bd37c687cbf9a8b683ba5f028645`. The image is a pre-existing local engine build, not a rebuild of candidate Java. The observed pending decision had a disabled match clock, null legacy balance, unknown inactivity deadline and the new warning; continuous snapshot reads did not prevent the engine's inactivity auto-concede and game-over callback. The opt-in test passed (1/1); the final normal MCP suite passed 64 tests with three opt-in tests skipped, zero failures. Neither check replayed or modified the reported production match. The disposable engine container was removed after verification.
