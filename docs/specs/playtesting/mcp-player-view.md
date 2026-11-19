# MCP player view

### PM-VIEW-01 — Equivalent gameplay choices

The MCP gameplay tools `get_game_state`, `play_line` and `wait_for_decision` accept `view: "compact"`. The response retains the game, epoch, cursor, timing, legal choices and all state needed to make a play, including rules, costs, ability text, targets, damage, and combat assignments. Execution status, progress and interruption signals remain available. Omitting `view` returns the existing full contract. Changing only the response view on a retained command does not replay an action.

### PM-VIEW-02 — References within one snapshot

A choice can carry `cardRef` in compact mode when its card matches a single visible card record in the same state by object ID and gameplay fields. Repeated identical records in the battlefield and combat describe one object. Conflicting records, cards without usable IDs and cards visible only in the prompt stay inline. Pile membership and current prompt text stay available. Compact cards omit empty hint lists and printing metadata. Live hints with content remain available because they can describe restrictions and other active effects.

### PM-VIEW-03 — Resume a line

A command wait uses the game and command IDs returned for the same line. Missing game IDs and cursor or decision filters produce `invalid_line_wait`. Ordinary waits can filter by the last observed cursor or decision. A compact timeout uses `state.cursor`, and a compact interruption retains any pending rollback vote and the current prompt. A compact error with current state exposes the same gameplay information as a compact success.

### PM-VIEW-04 — Recover from an ambiguous selector

When several options share a label, an ambiguous selector leaves the prompt open and tells the caller to use the current `decisionId` and exact `choiceId`. The option text or card detail remains available to distinguish the choices.

The HTTP tests in `ops/playtesting/mcp/test/player-view.test.mjs` cover these scenarios.

| Requirement | Test |
| --- | --- |
| PM-VIEW-01 | `compact state, line and wait carry the same actionable combat and target choices` |
| PM-VIEW-02 | `compact choices keep inline cards when a visible reference would lose information` |
| PM-VIEW-03 | `compact wait keeps rollback state and rejects incompatible command filters` |
| PM-VIEW-03 | `timeout and stale-line recovery keep the current cursor in compact state` |
| PM-VIEW-04 | `an ambiguous ability label can be recovered with the observed choice ID` |

The isolated XMage fixture in `ops/playtesting/product/sequence.local.mjs` checks paired UTF-8 MCP text lengths and equivalent prompts from actual engine callbacks. The fixture emits numeric sizes and its named scenarios.

## Local verification on 2026-11-18

The Node 22 Docker build succeeded. The MCP suite passed 258 tests, skipped 3 opt-in live tests and had zero failures. The isolated real-engine acceptance ran separately with synthetic seats, fresh PostgreSQL and the candidate MCP files over the local Playmat engine image.

| Same XMage position | Full MCP text (UTF-8 bytes) | Compact MCP text (UTF-8 bytes) |
| --- | ---: | ---: |
| Priority with spell and mana choices | 13,997 | 9,857 |
| Retained `play_line` at the target prompt | 9,834 | 8,823 |
| Command wait at the same target prompt | 9,834 | 8,823 |
| Ordinary target wait | 9,084 | 8,073 |
| Ordinary mana payment wait | 13,552 | 9,712 |

The live fixture matched the cursor, decision ID, priority and legal options across both views. It used the compact priority receipt for the real cast and the compact waits for its target and payment. Synthetic HTTP fixtures also cover combat, rollback, a repeated label, and recovery errors. The measurements record text sizes from the local MCP transport. They do not measure the archived Pioneer replay or changes in model latency.
