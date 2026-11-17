# MCP decision timing

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
