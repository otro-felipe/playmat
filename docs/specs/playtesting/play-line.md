# Semantic play lines

## PM-LINE-01 — Submit a complete justified line
A seated agent submits ordered `play_line` actions from its observed game ID and cursor. A line can begin in either player's turn. It supports the existing semantic play, attack, pacing and engine choice inputs. An exact observed choice and its optional value must have the same coverage as the low-level decision tool. A guarded future choice may use a currently knowable selector. The game validates each action at its actual prompt. The executor handles routine handoffs and ends the line at a significant opponent action, new information, a required choice not covered by the line, a configured stop, or an invalid action. Accepted actions stay applied.

An exact Keep may carry a line into the seat's first turn. A London bottom can continue only through its guarded choice. The opening line stops when the opponent starts or the seat sees an actual draw. From an observed casting prompt, a line may resume exact targets and mana payment for its face-up, unpaid, unresolved spell. It returns control after a reveal. A draw in a trigger's condition describes an event that already happened. Inspect the triggered effect for draws and other new information. An attack may declare its exact own triggers at confirmation. A trigger-order prompt publishes source identity and rule text for a face-up source on a visible battlefield. Its choice can identify that public source and an exact label. A source shared by multiple matching options is ambiguous.

## PM-LINE-02 — Pass with an explicit destination
A terminal `pass_until` action accepts `destination: "my_upkeep" | "my_draw" | "end_step" | "current_turn"` and `policy: "if_no_play" | "decline_optional"` (default `if_no_play`). Upkeep refers to the next own turn and returns control before drawing. Draw refers to the forthcoming own draw, including the same turn when called before the draw step. It returns control at the first actionable state after the draw boundary. The managed MCP engine seat requests explicit priority in its own upkeep and draw steps. A current-turn destination matches every supplied phase, step or priority condition. If the engine skips the requested window or no new card is confirmed in the own hand at the draw boundary, report the actual boundary and any new information without silently claiming the destination. The safe policy stops for a non-mana legal play before the destination. The explicit decline policy supports holding up mana and passing without revealing whether a response exists. Both policies stop for an opponent action, an unknown mandatory choice, or new information. A terminal `pass_priority` makes one deliberate ordinary pass and returns at the next actionable boundary without making another pass.

When `my_draw` follows earlier actions in the same line, its destination is chosen from the state after those actions. An already-skipped opening draw cannot prevent a line that just played a land from passing toward the next actual draw.

## PM-LINE-03 — Return the next decision in the same response
A line returns state and a receipt together. Within a bounded wait, return once the executor completes or interrupts. If the wait expires, return the same plan identity, current progress and seat-visible state, marking that the plan still owns execution. The client may wait for that plan's meaningful stop through the decision-wait tool. A transport cancellation ends the wait while preserving the receipt of any accepted line. Retrying an identical command ID in the same active seat process returns its receipt without replaying actions. Reuse with a different payload rejects. A stale or foreign request cannot affect an active plan.

## PM-LINE-04 — One bootstrap
A single guide request can load all four full guides. Guide loading and tool descriptions teach agents to submit the longest line justified by current information and stop to replan at a new decision. Existing tools remain available to compatible clients.

## Live playtest acceptance

- **PM-LINE-FLOW-1** Casting a modal spell with a confirmed deterministic mode can retain the planned continuation. A mode that reveals previously unavailable cards returns control before a later tactical action.
- **PM-LINE-FLOW-2** A planned decline of a known optional payment can retain the continuation when that branch reveals no new information. Accepting the discard-to-draw branch still requires inspection when the new card becomes visible. The answer must match the legal prompt.
- **PM-LINE-FLOW-3** A pass from an observed stack can advance to the first meaningful boundary. A rival action, a required decision the line cannot cover, or newly visible material information stops the line. An opponent's hidden draw and a draw visible to the acting seat are distinct.
- **PM-LINE-FLOW-4** Own expected triggers can be attached to an observed own resolving source, including a spell whose payment is already pending. Prepared copies and deterministic public triggers can carry a continuation when their source, causality and result are confirmed.
- **PM-LINE-SEM-1** A mana payment can identify a source and color without reproducing its printed rules. It follows the legal engine option and preserves its actual side effects, including painland damage.
- **PM-LINE-SEM-2** A mode, spell ability, or alternate cost can select a unique legal engine option from the same cast. A changed or ambiguous option leaves the next decision unapplied.
- **PM-LINE-SEM-3** Exact targets can be matched to their projected role or visible zone without reproducing a localized prompt. Distinct mandatory target prompts remain distinct. A cast with one declared public target can resume after the engine confirms it automatically.
- **PM-LINE-SEM-4** Mana-only priority does not interrupt safe passing. A separate legal non-mana play, including an alternate cost, still does.
- **PM-LINE-MCP-1** An agent can distinguish schema rejection, preflight rejection and a running or interrupted line using a stable code and execution evidence. A lost response is recoverable by the same command ID.
- **PM-LINE-MCP-2** Compact state is discoverable via the native MCP schema and retains the IDs, legal choices and current priority needed to continue. Connected catalog exposure requires separate verification.
- **PM-LINE-COMBAT-1** A line can submit and confirm exact legal blocker assignments. Combat can continue after confirmed damage between observed combatants or exact life loss from an observed unblocked attacker. A rival action or unexplained combat change returns control.

## Acceptance
- PM-LINE-01: exact numeric/array choice parity, a complete deterministic line, an observed library choice, and stops before applying tactics dependent on unseen information.
- PM-LINE-02: safe passing sees free plays, explicit decline can hold up mana, and upkeep and draw have distinct observed boundaries. Unavailable windows, opponent actions and mandatory choices stop safely.
- PM-LINE-03: a decisive line needs one MCP call from an observed cursor. Slow opponent, transport loss and changed command payload do not duplicate actions. A follow-up wait yields the plan stop and current view together.
- PM-LINE-04: one bundle returns all document bodies and the legacy single-guide input still works.

## Executable evidence

- `test/play-line-pass.test.mjs` covers safe and deliberate passes, skipped windows, callback timing, and exact choice parity.
- `test/play-line-http.test.mjs` exercises the MCP transport, command receipts, lost responses, and decision waits.
- `test/play-line-pass.test.mjs` characterizes the first-turn boundary after keeping, the omitted opening draw, the land followed by a single pass, and interruption on the first actual draw.
- `test/semantic-responses.test.mjs` (Fel) and `test/ability-panel.test.mjs` (HTTP/WebSocket picker) characterize the published `panel` kind and the current activation expectation boundary. `test/pioneer-line-boundaries.test.mjs` covers discard targets, a response to Annex, and Boseiju's land and Channel choices.
- `test/pioneer-line-boundaries.test.mjs` includes `[PM-LINE-01] confirmed attacks order exact public triggers and choose public graveyard targets in one line`, along with source-redaction and ambiguity checks.
- `test/play-line-http.test.mjs` (rollback callback) checks receipt recovery with a pending vote and rejects mixed cursor and command wait filters. `test/combat-boundaries.test.mjs` (Cottage and Sheoldred) checks the positive and negative evidence boundaries for simultaneous damage to a player and a blocker.
- `test/acceptance.test.mjs` checks the complete versioned guide bundle and its single-guide compatibility.
- `product/sequence.local.mjs` checks the managed upkeep and draw windows, two paid spells in one call with the resulting state, and interruption on a real rival mana activation. The fixture uses a fresh isolated Java engine and synthetic seats.
- `test/effect-boundaries.test.mjs` exercises PM-LINE-FLOW-1 through PM-LINE-FLOW-4, including adopted triggers, hidden opponent draws, observed and future optional questions, and prepared objects. `product/sequence.local.mjs` runs the selected Patrol and Date modes and the two Improvised Act branches in XMage over native MCP.
- `test/play-line-pass.test.mjs` exercises PM-LINE-SEM-1 through PM-LINE-SEM-4 via typed mana, prepared casting, mode and source binding, target roles, and mana-only priority.
- `test/play-line-http.test.mjs` checks the native validation and stale-cursor rejection receipts and compact schema discovery for PM-LINE-MCP-1 and PM-LINE-MCP-2.
- `test/combat-boundaries.test.mjs` checks the automatic assignment and confirmation of exact blockers and reconciles witnessed defending combat in PM-LINE-COMBAT-1.

Receipt recovery is process-local. A completed line can outlive the short HTTP request, but a restart loses the retained receipts. After an expired or uncertain receipt, read the current game state before choosing another action.
