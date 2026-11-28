# Thoughtseize core guide

This is the startup guide that `get_guide({"bundle":true})` returns. It covers the decision loop, the compact view, a minimal valid example for each common `play_line` shape and what to do after each stop. Read a detailed guide by ID only when you need it:

| `guideId` | When to read it |
| --- | --- |
| `getting-started` | Choosing a player, hosting or joining, sideboarding, chat modes and coaching, inactivity timers, recovery after a restart. |
| `turn-planning` | Worked lines from real matches: Ward, Reckless Rage, Mutavault, Sagas, trigger order, Valiant, mulligans, every pass destination, receipt timing fields. |
| `card-catalog` | Card lookup, deck validation and matchup research. |
| `matchup-strategy` | Read before a material tactical decision in a match, tournament or coaching session. Use the assigned list when available. |
| `rules` | Links to the Comprehensive Rules sections for timing questions. |

Re-read this guide after losing conversation context. Use `tools/list` for exact input schemas; never reuse a parameter from memory.

## Decision loop

1. On a shared connection call `list_players({})` and pass the selected `playerId` at the top level of every seat call.
2. Take the seat with `get_game_state({"gameId":"…","view":"compact"})`. Copy `gameId`, `cursor` and `decision`.
3. Send the longest justified line with `play_line`: a fresh `commandId`, the observed `cursor`, every known play, target, cost, choice and combat declaration, and one terminal pass. Use `view:"compact"`.
4. Read the receipt: `status`, `reason`, `appliedDecisions` and the returned `state`. Accepted actions stay applied. Continue from `state.cursor` with only the intentions that still make sense.
5. If `planOwnsExecution:true`, call `wait_for_decision({"gameId":"…","commandId":"…","view":"compact"})` with no cursor filters. A lost receipt is recovered the same way; never resend a partly applied line.
6. Answer every pending legal choice promptly. Polling, chat and analysis do not extend the inactivity deadline.

When an effect reveals information and its non-priority prompt is already open, send one `choose` with the exact IDs and any required `value`. Copy the selected option's `playLineAction` when present. Replan after the receipt, including when the next intended action is a pass.

If there is no decision or pending rollback, wait for the same game using `wait_for_decision({"gameId":"…","timeoutMs":25000,"view":"compact"})`. Immediately after the game opens, `priority:"none"` and no decision can also mean the engine is waiting for a game slot. Read the state returned by each wait. If the game, cursor and decision are unchanged, keep waiting without reloading the guide or requesting another copy of the board.

## Compact view

- `view:"compact"` keeps every ID, legal choice, public number and prompt field. The executor always validates against the full engine state.
- `play_line` and `wait_for_decision` receipts omit the `rules` of a card already sent in this game and set `state.rulesOmitted`. `get_game_state` always sends every rule again; call it after losing context.
- A choice `cardRef` names the visible object with the same ID. A plain single-colour mana choice has no `payWithOptions`: pay with its `objectId`.
- `timing.warning` appears once per game while unchanged; later receipts set `timing.warningRepeated:true`. The deadline in `timing.inactivity` is always current.
- `players[].command` lists public emblems, dungeons and commanders, which can be the `sourceId` of a stack trigger.
- `sequenceEvidence` keeps only revision counters; the executor reads the full ledgers.

## Minimal valid lines

Every example is a complete `play_line` input. Replace the IDs with those of your observed state.

**Keep an opening hand.** Copy the option's `playLineAction`, or guard the future mulligan prompt by its exact label:

```json
{"gameId":"00000000-0000-4000-8000-000000000001","cursor":2185,"commandId":"keep-001","view":"compact",
 "actions":[{"kind":"choose","decisionId":"<mulligan-decision-id>","choiceId":"<keep-choice-id>"}]}
```

A `choose` without `decisionId` needs a guard. `{"kind":"choose","guard":{"kind":"mulligan"},"select":{"label":"Keep"}}` is rejected because the guard names no instruction; use the observed `decisionId` and `choiceId`.

**Answer a future target prompt.** A target guard needs the source and the zero-based role, with the target object:

```json
{"gameId":"00000000-0000-4000-8000-000000000001","cursor":4111,"commandId":"target-001","view":"compact",
 "actions":[{"kind":"choose","guard":{"kind":"target","targetSourceId":"<spell-or-source-id>","targetRole":0},
   "select":{"objectId":"<target-id>"}}]}
```

When you cast the spell in the same line, prefer `targets` on the `play` action.

**Cast with targets, mana and kicker declined.** `optionalCosts` answers this cast's "Pay Kicker … ?", buyback and multikicker questions. With `"pay"`, include the extra mana in `payWith`:

```json
{"gameId":"00000000-0000-4000-8000-000000000001","cursor":4106,"commandId":"burst-001","view":"compact",
 "actions":[{"kind":"play","when":"priority","select":{"objectId":"<burst-lightning-id>","zone":"hand"},
   "optionalCosts":"decline","targets":[{"role":0,"select":{"objectId":"<target-id>"}}],
   "payWith":["<mountain-id>"]},
  {"kind":"pass_until","destination":"end_step"}]}
```

**Choose X on an open numeric panel.** Suppose March of Otherworldly Light asks for X while Academic Dispute is on the stack. For a choice with `type:"number"`, put the chosen integer in `value`. Here the pilot chooses 2 within the displayed range. Copy the current numeric option ID and decision ID, then send just that choice. Inspect the receipt before paying the cost or choosing a target.

```json
{"gameId":"00000000-0000-4000-8000-000000000001","cursor":4120,"commandId":"march-x-002","view":"compact",
 "actions":[{"kind":"choose","decisionId":"march-x","choiceId":"march-x-answer","value":2}]}
```

At a subsequent `payMana` panel, button and object options use `choiceId` alone within the observed decision. For example, after inspecting the available payment options and choosing the button, send:

```json
{"gameId":"00000000-0000-4000-8000-000000000001","cursor":4121,"commandId":"march-payment-003","view":"compact",
 "actions":[{"kind":"choose","decisionId":"march-payment","choiceId":"confirm-cost"}]}
```

**Attack.** A plain `attackers` list attacks the opposing player, even when a planeswalker or battle could be attacked. Use `assignments` with `defenderId` to split the attack. A token that an expected attack trigger creates "tapped and attacking" joins its source's defender, or `tokenDefenderId` when you name one:

```json
{"gameId":"00000000-0000-4000-8000-000000000001","cursor":3725,"commandId":"attack-001","view":"compact",
 "actions":[{"kind":"pass_until","destination":"current_turn","step":"DECLARE_ATTACKERS","priority":"self"},
  {"kind":"attack","assignments":[
     {"attackerId":"<soul-scar-mage-id>","defenderId":"<planeswalker-id>"},
     {"attackerId":"<den-of-the-bugbear-id>","defenderId":"<opponent-player-id>"}],
   "expectTriggers":[{"sourceId":"<den-of-the-bugbear-id>",
     "abilityText":"Whenever this creature attacks, create a 1/1 red Goblin creature token that's tapped and attacking."}]},
  {"kind":"pass_until","destination":"end_step"}]}
```

**Let a visible stack resolve.** `expectedStackIds` is a top-level field, never inside an action. Copy it from `state.decision.visibleStackArgs`:

```json
{"gameId":"00000000-0000-4000-8000-000000000001","cursor":3567,"commandId":"resolve-001","view":"compact",
 "expectedStackIds":["<stack-object-id>"],
 "actions":[{"kind":"pass_until","destination":"my_upkeep","policy":"decline_optional"}]}
```

**Pass to your next turn.** `my_upkeep` stops before your draw; `my_draw` stops after it. `policy:"if_no_play"` (default) returns at any legal non-mana play; `decline_optional` deliberately skips them, land drops included.

```json
{"gameId":"00000000-0000-4000-8000-000000000001","cursor":3826,"commandId":"pass-001","view":"compact",
 "actions":[{"kind":"pass_until","destination":"my_draw","policy":"decline_optional"}]}
```

During an automatic pass, a rival triggered ability from a source that was already public when the line began resolves without a stop: Sheoldred's lifegain or an emblem's drain, for example. The line still stops when such a trigger targets a permanent or spell, reveals information or asks you to choose, and under `if_no_play` when you hold a legal response.

## After a stop

| `reason` or `code` | What happened | Next call |
| --- | --- | --- |
| `completed` status | The line reached its destination. | Plan from `state`. |
| `opponent_action` | The rival cast a spell or activated an ability. | Read `state.stack`. Respond, or pass with its ID in top-level `expectedStackIds`. |
| `state_changed` | An unplanned object reached the stack, or a planned prompt changed. | Read `state.stack` and `state.decision`; adopt objects with `expectedStackIds` or answer the open prompt. |
| `opponent_state_changed` | Public rival state changed without a verified planned cause. | Re-read the board and replan. |
| `new_information` | You drew, revealed, looked at or searched. | Replan with the new card; never pre-decide an unseen card. |
| `response_available` | A mandatory prompt the line did not cover, or a legal play under `if_no_play`. | Answer `state.decision` with its `decisionId` and `choiceId`, then send the rest. |
| `before_draw_trigger` | This upkeep is your last window to act before a public draw trigger. | Act, or send a fresh pass from this upkeep. |
| `destination_skipped` | The engine skipped the requested window. | Read `lastDestination` and the current decision. |
| `land_play_unavailable` | No legal land drop in this window. | Drop the land action and continue. |
| `reevaluation_required` | The line crossed a pending choice or can reveal new information. | If `state.decision` is an open panel or another non-priority prompt, send only its exact `choose`. Otherwise end at the information-changing action and replan from its receipt. |
| `invalid_line_arguments` | Schema rejection; nothing applied. | Fix the action at `issues[].path`. For an already visible choice, use its `playLineAction` or exact IDs. |
| `bad_sequence` | A pass before another action must name the current-turn window. | Use `current_turn` with an explicit step or phase and `priority:"self"` for an intermediate pass. Put the terminal pass last. |
| `stale_decision` | The decision ID is no longer current. | Use the decision in the returned state. |
| `timeout` | The bounded wait ended; the line may still run. | `wait_for_decision` with the same `gameId` and `commandId`. |
| `chat_closed` | The game ended and XMage closed its chat. | Send the message in the next game, or before conceding. |

Read `nextAction` for the verified cursor, decision and applied count on a line receipt. A read or wait includes its tool arguments. For an open panel, fill the listed `requires` fields with a fresh command ID and your own legal selection from `state.decision.choices`. Numeric choices need your chosen `value`. Submit the single choice and inspect the next receipt. Accepted steps stay applied when you resume. Read `get_game_state` when the receipt has no state or you lost track of the current game. The `turn-planning` guide has worked examples.

## Chat

Follow the host `chatMode`: quiet sends nothing unsolicited, chatty is friendly conversation without coaching, coach follows the procedure in `getting-started`. `send_chat` works only while a game is active. Say GG before conceding or during the next game. Keep hidden information out of chat and never let chat delay a pending decision.
