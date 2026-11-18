# Semantic play lines

## PM-LINE-01 — Submit a complete justified line
A seated agent submits ordered `play_line` actions from its observed game ID and cursor. A line can begin in either player's turn. It supports the existing semantic play, attack, pacing and engine choice inputs. An exact observed choice and its optional value must have the same coverage as the low-level decision tool. A guarded future choice may use a currently knowable selector. The game validates each action at its actual prompt. The executor handles routine handoffs and ends the line at a significant opponent action, new information, a required choice not covered by the line, a configured stop, or an invalid action. Accepted actions stay applied.

## PM-LINE-02 — Pass with an explicit destination
A terminal `pass_until` action accepts `destination: "my_upkeep" | "my_draw" | "end_step" | "current_turn"` and `policy: "if_no_play" | "decline_optional"` (default `if_no_play`). Upkeep refers to the next own turn and returns control before drawing. Draw refers to the forthcoming own draw, including the same turn when called before the draw step. It returns control at the first actionable state after the draw boundary. The managed MCP engine seat requests explicit priority in its own upkeep and draw steps. A current-turn destination matches every supplied phase, step or priority condition. If the engine skips the requested window or no new card is confirmed in the own hand at the draw boundary, report the actual boundary and any new information without silently claiming the destination. The safe policy stops for a non-mana legal play before the destination. The explicit decline policy supports holding up mana and passing without revealing whether a response exists. Both policies stop for an opponent action, an unknown mandatory choice, or new information. A terminal `pass_priority` makes one deliberate ordinary pass and returns at the next actionable boundary without making another pass.

## PM-LINE-03 — Return the next decision in the same response
A line returns state and a receipt together. Within a bounded wait, return once the executor completes or interrupts. If the wait expires, return the same plan identity, current progress and seat-visible state, marking that the plan still owns execution. The client may wait for that plan's meaningful stop through the decision-wait tool. A transport cancellation ends the wait while preserving the receipt of any accepted line. Retrying an identical command ID in the same active seat process returns its receipt without replaying actions. Reuse with a different payload rejects. A stale or foreign request cannot affect an active plan.

## PM-LINE-04 — One bootstrap
A single guide request can load all four full guides. Guide loading and tool descriptions teach agents to submit the longest line justified by current information and stop to replan at a new decision. Existing tools remain available to compatible clients.

## Acceptance
- PM-LINE-01: exact numeric/array choice parity, a complete deterministic line, an observed library choice, and stops before applying tactics dependent on unseen information.
- PM-LINE-02: safe passing sees free plays, explicit decline can hold up mana, and upkeep and draw have distinct observed boundaries. Unavailable windows, opponent actions and mandatory choices stop safely.
- PM-LINE-03: a decisive line needs one MCP call from an observed cursor. Slow opponent, transport loss and changed command payload do not duplicate actions. A follow-up wait yields the plan stop and current view together.
- PM-LINE-04: one bundle returns all document bodies and the legacy single-guide input still works.

## Executable evidence

- `test/play-line-pass.test.mjs` covers safe and deliberate passes, skipped windows, callback timing, and exact choice parity.
- `test/play-line-http.test.mjs` exercises the MCP transport, command receipts, lost responses, and decision waits.
- `test/acceptance.test.mjs` checks the complete versioned guide bundle and its single-guide compatibility.
- `product/sequence.local.mjs` checks the managed upkeep and draw windows, two paid spells in one call with the resulting state, and interruption on a real rival mana activation. The fixture uses a fresh isolated Java engine and synthetic seats.

Receipt recovery is process-local. A completed line can outlive the short HTTP request, but a restart loses the retained receipts. After an expired or uncertain receipt, read the current game state before choosing another action.
