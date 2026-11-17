# Plan a turn

Play to win from your seat's view. For a London mulligan, prioritize castable early plays, usable colors, and a plan for the matchup. At very low hand sizes, keep a functional line instead of chasing the ideal hand. If you kept after a mulligan, answer the engine's prompt for the cards to put on the bottom.

At each meaningful priority window, decide who benefits if the game goes long. Check your mana, the opponent's available mana, life totals, combat math, immediate threats, and how your hand can use the next land drop. Consider how to make the opponent commit first, when to play around a likely response, and whether adding another threat exposes you to a sweeper. Compare the sequencing alternatives privately. Treat an inferred archetype or a possible response as a hypothesis. Maintain and update the compact public-information response ledger described in the cards and matchups guide; a nonresponse reduces a hypothesis only when it was a meaningful legal opportunity, never proves absence.

## Execute a conditional line

Use `play_sequence` to queue up to twelve guarded choices, passes, or brief waits from the current `gameId` and `cursor`. Plan as far as you can justify from the visible state. After a draw, reveal, an uncertain resolution, or an opponent's response that could change the line, look again and replan.

- An `answer` needs an exact `decisionId` or a `guard` with the expected decision kind and a phase, step, or priority. Use exactly one `choiceId` or semantic `select`. Use a physical card ID when more than one choice matches a name. `zone: "battlefield"` covers all players' public battlefields, including opposing targets; it does not mean your battlefield. `zone: "hand"` means your visible hand only. If both players have the same named permanent, use the exact offered `choiceId` or `select.cardId` to avoid `ambiguous_choice`. Zone selection never authorizes an object absent from the engine's legal choices.
- `expectCast: true` marks a visible legal spell selected during `priority`, from your hand or a public exile/graveyard zone. The plan can continue to mode, target and payment decisions for that same spell, each with its own guard. Put `expectCast` only on the initial cast, never on the later mode, target or mana answers. Do not use it for lands, activated abilities or unrelated additions to the stack. For exile/graveyard casts, use the current exact `choiceId` or `select.cardId` without `zone: "hand"`; zone selectors currently only support hand and battlefield. XMage, not the zone or this flag, grants permission to cast. Older deployments may reject non-hand casts with `bad_cast_expectation`; inspect the applied-step count and fresh state instead of replaying the whole plan.
- `hold` waits up to ten seconds inside a decision. Use it sparingly and account for the match clock.
- `pass_until` submits ordinary passes until the observed state matches every supplied phase, step and priority condition. A destination already matching the current state completes immediately, without passing. `priority: "self"` identifies the priority holder, not the active player. By default, a non-pass, non-mana choice interrupts with `response_available`; mandatory prompts and unexpected stack changes also stop the sequence. Use `wait_until` to observe a destination without passing; it cannot advance a game waiting for your decision.

## Avoid passing your own turn

`END_TURN` is the engine's end-step name. It does **not** mean “finish the opponent's turn and stop on my next turn.” Phase, step and priority conditions have no player or future-turn qualifier. If you start too late to observe an end step, the next matching step might belong to a later turn. Older servers could keep passing into that turn. In particular, `skipOptionalResponses: true` suppresses the safety stop for **all optional choices, including playing a land or casting a spell**, not just responses to an opponent. It can pass your first main phase without playing a land.

The server now interrupts every sequence with `turn_changed` when the observed turn number or active player changes, before submitting another choice. This protects a new turn even with `skipOptionalResponses: true`, but does not protect a land drop in the turn where you started the sequence. A destination reached after a turn boundary still requires a fresh plan. Clients need no new arguments; older deployments may lack this protection.

Use this procedure:

1. Read `get_game_state`. Compare `activePlayer` with your seat's name in `players`; read `turn`, `step`, `priority`, the stack and the current decision. Having priority does not mean it is your turn.
2. When waiting for an opponent who has the decision, use `wait_for_decision` with the observed cursor, or `wait_until` for observation. When you have a priority decision, submit one visible pass with `submit_decision`, then inspect the next state. This works on older servers too.
3. If batching passes within the observed turn, leave `skipOptionalResponses` false. For example, `{"kind":"pass_until","step":"PRECOMBAT_MAIN","priority":"self"}` can reach your first main phase when started in your own upkeep. It will not wait for a future main phase if that destination already matches. Stop and reassess any available response.
4. Check `get_sequence_status` until the plan is no longer running. After `turn_changed`, `response_available` or any other interruption, read `get_game_state`; do not blindly repeat an end-step plan. `cancel_sequence` stops remaining steps without undoing accepted actions.
5. In your own `PRECOMBAT_MAIN`, inspect available land choices and your hand, play the intended land with a visible choice, then reassess your spells and mana before passing. Only set `skipOptionalResponses: true` after deliberately deciding to decline every optional play in the current turn.

For example, with priority in `PRECOMBAT_MAIN`, Forest and Llanowar Elves in hand, and an available land drop, send these `steps` with the observed `gameId` and `cursor`:

```json
[
  {
    "kind": "answer",
    "select": {"cardName": "Forest", "zone": "hand"},
    "guard": {"kind": "priority", "step": "PRECOMBAT_MAIN"}
  },
  {
    "kind": "answer",
    "select": {"cardName": "Llanowar Elves", "zone": "hand"},
    "guard": {"kind": "priority", "step": "PRECOMBAT_MAIN"},
    "expectCast": true
  },
  {
    "kind": "answer",
    "select": {"cardName": "Forest", "zone": "battlefield"},
    "guard": {"kind": "payMana", "step": "PRECOMBAT_MAIN"}
  }
]
```

After paying, inspect the next priority and stack before passing or committing another play.

## Queue a line and hand over priority

`play_sequence` and its alias `submit_sequence` execute a whole justified line, rather than requiring one tool call per card or mana source. The example above already queues land → spell → payment. For a fully known payment line, you can append a guarded pass and stop when the opponent gets priority:

```json
[
  {
    "kind": "answer",
    "choiceId": "pass",
    "guard": {"kind": "priority", "step": "PRECOMBAT_MAIN", "priority": "self"}
  },
  {"kind": "pass_until", "priority": "opponent"}
]
```

Append these to the same `steps` only if you intend to pass after that spell's payment and no unplanned target, mode or additional-cost prompt is needed. The guarded `answer` waits for the next priority decision and passes exactly once; it does not keep skipping your other optional plays. The last step stops on opponent priority. If the spell resolves or the opponent changes the stack before that state is observed, the sequence interrupts instead; read the fresh state. It does not promise to run through a resolution and return to your next priority window.

To advance to a known phase after completing your plays, use a `pass_until` with that exact destination and `skipOptionalResponses: false`. For example, your own first main phase → `BEGIN_COMBAT` can stop for a newly available play or a response. Do not use `priority: "self"` alone to mean “the next time I have priority”: if you already have it, the condition is already satisfied. Use `yield_priority` below when you mean an actual handoff, not an already-matching state.

To pause before deciding, start a plan from a fresh current decision with `{"kind":"hold","delayMs":1000}` and then a guarded answer. Prefer an explicit `pace` step for a bluff/reading beat in ordinary priority. Both pauses are capped at one second, the sequence budget, the reported match-clock balance and any authoritative own inactivity deadline, leaving one second for answering. Unknown inactivity timing caps the pause at 250 ms. A pause never stops either clock or proves which cards the rival holds. A null `secondsRemaining` is not unlimited decision time. A hold immediately after another action requires a new decision to have arrived already, so do not rely on it to wait for the next prompt. Use brief pauses sparingly; they do not reveal whether the opponent has a response. Use `wait_for_decision` for observation while the other player decides. Follow the pending-decision procedure in `getting-started`; resolve the visible decision before optional research or commentary.

Use `get_sequence_status` to learn where a background plan ended. A changed stack, unexpected prompt, reconnect, or rewind can invalidate the remainder. Read `get_game_state` to decide again. `cancel_sequence` stops unapplied steps. XMage owns the board and determines the actual legal choices.

### Replan after engine-selected choices

XMage can automatically select a sole legal target or omit a prompt. Do not assume every conceptual choice produces a separate decision. For example, a Reckless Rage line targeting the opponent and then your own creature may jump directly to `payMana` if your own target is unique. A mismatching target guard safely interrupts; read the fresh decision and plan only the remaining payment, never repeat the already accepted target.

A live Heroes' Hangout line completed three decisions: cast from hand with `expectCast: true`, choose the exact mode with its own guard, then pay using Shivan Reef. The mode itself must not carry `expectCast`. Local regression tests also cover cast-from-exile and cast-from-graveyard followed by payment, while rejecting lands, non-priority modes and unrelated stack controllers.

## Continue a conditional line, not an unconditional script

A longer plan may include multiple cast → mode/target → payment → resolution segments and then advance toward the end step. Every answer still uses an exact visible choice or a guard and semantic selector. Do not invent future choice IDs. The same limits apply: twelve steps, sixty seconds of active execution, at most thirty automatic passes, and never beyond the observed turn. Split larger plans at meaningful decisions, not merely at every card click.

### Yield once and regain control

`{"kind":"yield_priority","until":"self","allowPlannedResolutions":true}` waits for your next ordinary priority prompt, submits **exactly one** deliberate pass, and waits for a different decision belonging to you. It never mistakes the old priority snapshot for a return, even if the engine acknowledges before publishing its update. A mandatory target/mode prompt returns control for replanning rather than being passed. `until: "opponent"` ends on the observed opponent handoff instead. If the handoff is too brief to observe, the plan may interrupt or time out; it does not submit another pass to manufacture it.

This is an intentional yield, including when you could play something else. It is not the automatic “I have no action” policy. To bluff or probe, deliberately yield and inspect the resulting public state; a pass or delay does not establish what is in the opponent's hand. Use a brief `hold` before yielding only from a fresh decision and account for your clock.

### Wait through only the resolutions you planned

After the known cast and payment steps, this step can advance through ordinary pass-only windows until your stack is empty and you have priority:

```json
{"kind":"pass_until","stackEmpty":true,"priority":"self","allowPlannedResolutions":true}
```

`allowPlannedResolutions` defaults to false and applies only during that step. It permits removal of the exact stack objects previously introduced by this sequence's `expectCast` or `expectTriggers` answers. It does not approve other spells, abilities, triggers, changed controllers or reordered stacks. An opponent response or any unexpected addition interrupts with `state_changed` before the next queued action. Drawn/newly visible cards in your hand or exile interrupt with `new_information`. A turn boundary still interrupts with `turn_changed`. This is a conservative no-response continuation, not a general branching language or a guarantee that every effect is predictable. The engine now supplies a public causal witness: per-player counters of committed public casts, activations (including mana), land plays, special actions and combat declarations, plus a bounded history of public stack IDs beginning resolution. It contains no private clicks, prompts, decisions, card names or hidden-zone identities. Damage, life loss, tapping or destroying an opposing object is an effect, not an action by its recipient. When the exact planned own object is verifiably resolving and the rival action counter is unchanged, those effects do not interrupt. A real rival action interrupts with `opponent_action`, even if its activation adds no stack object or arrives in the same update as your own damage. Unknown stack additions, altered objects or unplanned resolutions still stop. Missing/changed witness epochs or truncated resolution evidence fail closed; an old engine without the witness cannot safely authorize continued resolutions. Other unexplained public changes still interrupt with `opponent_state_changed`.

After that step, add the next guarded play if it remains justified, or `{"kind":"pass_until","step":"END_TURN"}` after deliberately finishing your plays. If there is another available non-mana play, automatic passing stops with `response_available`: choose the play or explicitly decline it. Never guess “no action” from zero mana, empty hand or tapped lands; free spells, alternate costs and abilities may still be legal. The engine's current choices are the authority. Automatic passing skips only ordinary pass/mana-only windows by default, never mandatory choices or configured stops. `skipOptionalResponses: true` remains an explicit decision to decline all optional plays during that pass step, not a resource detector.

Inspect `get_sequence_status` after each plan. On interruption, keep accepted steps, read the new decision and replan only the remainder; cancellation does not undo actions. These new fields require an updated server/client tool schema. If your connector still exposes only the older schema, use bounded supported steps rather than sending unsupported arguments or assuming the feature is deployed.

### Explicit commitment versus guarded passing

These are deliberately different operations:

- The standalone **`pass_until` tool** means “I have decided not to make any optional play before this destination.” It continues through opponent responses and declines optional responses until the supplied phase/step/priority is observed. It still never chooses targets, modes, payments, attacks or other mandatory answers, and never crosses the current turn. A destination already matching completes without passing. It returns a sequence ID for monitoring/cancellation.
- A **`pass_until` step inside `play_sequence` / `submit_sequence`** belongs to a conditional plan. Even if you set `skipOptionalResponses: true` to deliberately decline your optional actions, an opponent response or public opponent-state change interrupts and returns control before the next queued choice. The setting does not disable the plan's interruption guard.

For example, a guarded line can pass to `DECLARE_ATTACKERS`, select the known attackers, confirm the attack, and pass to `POSTCOMBAT_MAIN`. A live four-step line completed six decisions and stopped in the same turn. Queue only attackers/choices justified by the current public position; on interruption, reassess combat rather than replaying it. The standalone pass tool, in contrast, is only for a real commitment to decline optional responses, not a substitute for such a conditional attack line.

### Waiting for the opponent

A running plan reports `waitingFor: "opponent"` while the opponent has priority and you have no visible decision. That interval does not consume the sixty-second active-execution budget. The plan resumes on engine events, without repeated passes or polling actions. A hard fifteen-minute wall lifetime, game/turn boundaries, authorization checks, explicit cancellation and disconnect/rewind invalidation still bound it. It is durable across a slow opponent's decision **within the current server process**, not across process restart/deployment. Continue using status/event notifications to learn when control returns. If a plan expires, inspect state and start a fresh plan rather than replaying accepted moves.

## Preplan your own triggers, not arbitrary interruptions

You can queue known trigger targets, modes or yes/no choices as guarded `answer` steps. Put `expectTriggers` on the action that will cause the trigger. Each expectation names one **visible own source object ID**, the exact public `abilityText`, and a bounded count (default one, maximum four). The server accepts only `TRIGGERED_NONMANA` objects controlled by your seat with that exact source and text. The same update may contain your planned spell and expected trigger, but an extra opponent spell, different trigger, changed controller, wrong source, exhausted count or duplicate expectation interrupts the whole remainder.

This is a template, not literal engine IDs/text. Substitute data verified from the current public game/source or a previously observed public trigger; if you cannot identify it exactly, let the sequence stop and inspect it instead of guessing:

```json
[
  {
    "kind": "answer",
    "decisionId": "CURRENT_DECISION_ID",
    "choiceId": "CURRENT_ACTION_ID",
    "expectTriggers": [{"sourceId": "VISIBLE_OWN_SOURCE_ID", "abilityText": "EXACT_PUBLIC_TRIGGER_TEXT", "count": 1}]
  },
  {
    "kind": "answer",
    "guard": {"kind": "target", "step": "PRECOMBAT_MAIN", "instruction": "EXACT_ENGINE_PROMPT_TEXT"},
    "select": {"cardId": "INTENDED_LEGAL_TARGET_ID", "zone": "battlefield"}
  }
]
```

If the first action is casting a spell, add `expectCast: true` on that answer as well. The trigger source may be a visible card already on your battlefield/in your hand, or the legal spell selected by that cast. Do not predeclare a hidden/face-down source or an opponent source. Public stack projections expose `abilityType`, `sourceId`, `abilityText` and the actual stack controller, without copying private source-card details.

A trigger's target prompt can arrive **before** its stack object appears. `guard.instruction` matches the exact visible prompt in addition to kind and timing; use it for preplanned mandatory choices to avoid treating an unrelated prompt as the expected trigger. It is not a causal trigger ID: a generic prompt alone cannot prove which effect caused it. If the prompt/source is uncertain, stop and decide from fresh state. Only currently legal engine choices can be answered. A vanished target, ambiguous selector, changed prompt or auto-selected/omitted prompt interrupts safely. Never replay already accepted actions.

Expected trigger stack objects may resolve during an `allowPlannedResolutions: true` pass/yield step, just like the plan's expected spells. Undeclared triggers still interrupt. Newly revealed/drawn cards and public opponent-state changes still return control, even if caused by your trigger. This is not a general auto-target policy, and it never guesses random targets or accepts all triggers. Servers must have the new public trigger metadata and clients must expose the new schema before using it; otherwise use ordinary guarded steps and replan when interrupted.


## Three deliberate ways to proceed

1. **No useful legal play now:** use `advance_to_own_turn` (standalone, or the final step of a guarded sequence). It inspects the engine's current choices, never your mana balance as a proxy. It passes only ordinary priority windows without a non-mana play, stops for free/alternate-cost spells, land drops, useful/uncertain abilities, mandatory choices, configured stops or real rival actions, and stops as soon as the next own turn is observed before answering that turn. A mana option is ignorable only when its visible rules demonstrate plain tap-for-mana production without extra activated effects. Unknown mana ability text returns control. The bounded mode permits routine turn/phase/draw transitions with uninterrupted public evidence; it is capped at eighty passes, sixty active seconds and fifteen minutes wall time. Read the fresh state before choosing anything on that next turn. Ordinary `pass_until` still never crosses a turn.
2. **A complete conditional turn:** plan the strongest justified full line assuming the rival only passes, including cast, exact targets, payments, declared triggers, own resolutions and the intended end step. Open rival mana does not by itself stop a line or prove an answer exists. Use `allowPlannedResolutions:true` on resolution waits and declare each spell/trigger exactly. Compare credible counter-lines before starting. When a real rival action or an unexpected own decision occurs, inspect the new public state and replan only the unapplied remainder. Do not repeat acknowledged actions. The twelve-step bound can require splitting at a meaningful decision; that is not permission to guess later choices.
3. **Resources available, consciously decline:** use a brief `{"kind":"pace","delayMs":250}` before one deliberate yield or guarded answer. This is bounded pacing, not an information oracle. Never waste the clock or infer card absence from how long the rival takes. A changed prompt or new public rival action cancels the remainder, and mandatory prompts are never held by `pace`.

These behaviors require a newly assembled engine/JAR with the witness, a rebuilt MCP core, and a client catalog exposing the new schemas. A source deployment does not update a host's stored tool definitions. Without the fields in the client's schema, use supported bounded decisions and replan after interruption; do not send undocumented arguments or disable guards.
