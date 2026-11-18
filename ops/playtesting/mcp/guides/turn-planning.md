# Play a line

Play to win from your seat's view. Compare credible lines using your hand, available mana on both sides, combat math, likely interaction and the cost of committing first. During a London mulligan, prioritize castable early plays, usable colors and a plan for the matchup. In a small hand, keep a functional line over chasing the ideal draw. When you keep after a mulligan, answer the engine's separate bottom-card prompt with the cards it asks for.

## Submit the longest justified line

Use `play_line` for the longest line you would commit to if the opponent only passes. It can begin in either player's turn. Include land drops, spells, known modes, targets and costs, combat, postcombat plays and your intended stopping point in one call. The executor supplies routine priority handoffs and checks each intention against the live XMage choice. Open opposing mana shapes your strategy. Once you pick a line, ordinary passes and expected resolutions can happen without another decision from you.

Start from your observed `gameId` and `cursor`. Give each new line its own `commandId`. The IDs below are placeholders for your current game's IDs.

```json
{
  "gameId": "<current game UUID>",
  "cursor": 29,
  "commandId": "turn-2-line-1",
  "actions": [
    {"kind":"play","select":{"cardId":"<Mountain ID>","zone":"hand"}},
    {"kind":"play","select":{"cardId":"<Swiftspear ID>","zone":"hand"},"payWith":["<Mountain object ID>"]},
    {"kind":"attack","attackers":"all"},
    {"kind":"pass_until","destination":"my_draw"}
  ]
}
```

This line plays Mountain, casts and pays for Swiftspear, attacks and passes toward the next own draw while the engine offers only ordinary passes or plain mana production. It stops before applying the rest of the line when the opponent takes a meaningful action, a required choice is missing, information arrives, a configured stop applies or the available choice differs from the plan.

## Choose when to pass

| Intention | Final action |
| --- | --- |
| Cede priority once and see whether the opponent commits | `{"kind":"pass_priority"}` |
| Continue while no optional play is offered until your next upkeep, before the draw when that window is available | `{"kind":"pass_until","destination":"my_upkeep"}` |
| Continue while no optional play is offered until you can plan from your next draw | `{"kind":"pass_until","destination":"my_draw"}` |
| Stop at the current turn's end step | `{"kind":"pass_until","destination":"end_step"}` |
| Stop at your postcombat priority in the current turn | `{"kind":"pass_until","destination":"current_turn","step":"POSTCOMBAT_MAIN","priority":"self"}` |
| Deliberately hold up mana and decline optional plays until a defined point | `{"kind":"pass_until","destination":"my_draw","policy":"decline_optional"}` |

The default `if_no_play` policy checks the engine's choices. Tapped lands and zero mana can coexist with a legal land drop, free spell, alternate cost or activation, so those choices can bring you back into the line. The policy skips only ordinary priority and known mana-only choices before the destination. `decline_optional` is a strategic commitment to skip optional plays along the way, including land drops. Both policies return control for an unexpected opponent action, new information or a required choice. The terminal pass never queues a new turn's plays after the draw.

For a bluff, hold your resources open and choose the single priority handoff or a deliberate pass to a specified stop. A brief `{"kind":"pace","delayMs":250}` before the pass is optional and capped by the current clocks. A delay does not establish what the opponent holds. Use `wait_for_decision` when you intend only to observe.

From your own untap or upkeep, `my_draw` aims for this turn's draw. From later in your turn or during the opponent's turn, it aims for your next turn's draw. A normal draw occurs before the draw step's priority. Use `lastDestination` and the returned state to see the exact step or the first actionable post-draw decision. If the engine skips your requested upkeep window, `destination_skipped` returns the observed boundary, which may already include the draw. A mandatory trigger can still ask you to decide sooner.

`current_turn` requires at least one exact `phase`, `step` or `priority` condition. Multiple conditions must all match. `priority:"self"` alone means any position where you currently have it, which may already be true. Use `pass_priority` for an actual handoff.

## Express every visible engine choice

Use `{"kind":"choose","decisionId":"<observed prompt>","choiceId":"<legal option>"}` for any observed engine choice, including mulligan, cards to put on the bottom, attackers, blockers, mode, targets, mana or costs. Supply the engine's requested numeric or array `value` when shown. A line of observed choices with no terminal pass returns after the answer reaches a new state. For a future choice you can already justify, provide a matching `guard.kind` and the exact prompt `guard.instruction` together with a unique `select`, such as the card or exact option label. Use either `choiceId` or `select`. Copy IDs from an observed state and guard future prompts by their published details.

- **Play and pay.** A `play` uses a unique visible selector. It waits for an empty stack by default. Use `when:"priority"` for a deliberate response on the stack. `payWith` names specific mana source object IDs. If a source needs a color or ability choice, add a guarded `choose` in the expected order. Only omit chosen sources when relying on configured engine auto-payment.
- **Modes and special actions.** If XMage opens a cast/plot picker before targets and payment, put the guarded picker next. For plot use `expectCast:false` on the `play`. For an own activated ability such as leveling a Class, select the actual legal option with `choose` and the exact `expectAbility:{sourceId,abilityText}`. Queue its known payment and give a separate `expectTriggers` entry for a predictable Talent return trigger with a known target.
- **Targets.** Give a `play.targets` entry as `{"select":{"objectId":"<visible object ID>"},"instruction":"<exact target prompt>"}`. Reckless Rage needs the opponent's creature and your creature in the order XMage asks for each role. If a mode comes first, use guarded `choose` entries in the known engine order for the mode, targets and payment. A sole target already selected by XMage can be skipped only when the exact public spell records that exact target. Never treat a later payment or discard prompt as a target.
- **Predictable triggers and Ward.** Declare an own trigger with `expectTriggers` using its visible source ID and exact public ability text. Opposing Ward uses `expectTargetTriggers` with the public Ward source ID, your spell's `targetingCardId` and the exact public Ward text. Queue a guarded answer to the Ward question and a guarded choice of the exact card to discard or cost to pay. A different source, trigger, prompt or illegal cost returns control.
- **Specific cards and combat.** Use IDs to distinguish copies or opposing objects with the same name. Hand selectors refer to your own visible hand. Graveyard and exile casts use a visible `cardId` without a hand zone when XMage permits the play. `attack` accepts `"all"` or selected attacker IDs. Use guarded or observed `choose` for engine selections such as a defender, a blocker assignment, or confirmation.

The executor tracks your currently visible stack objects by default. When planning through the known resolution of an object already on the stack, `expectedStackIds` can name the exact visible stack objects to adopt. Supplying it replaces the default list, so include any of your own existing objects that the line expects to resolve. A future response is new information.

## Stop when your information changes

An own draw, a reveal, a newly presented search or scry, a random result, or an actual opponent action can change the best line. Put known costs, targets and modes before the information-changing resolution. For example, cast and pay for Opt in one call, then choose from the actually observed scry prompt in a new line. Use `reevaluateAfter:true` on the final strategic intention for an uncertain outcome the tool may not recognize. The engine validates what your seat can see and do. Opponent passes and delays are incomplete evidence of hidden cards. Use the public-information hypotheses in the card catalog guide when comparing responses.

## Continue from the receipt

Read the returned `state` together with `status`, `reason`, `appliedDecisions` and any error. `needsAgent:true` marks a decision that needs your attention. Replan from that state and carry forward only unreached intentions that still make sense. Previously accepted moves remain applied. If the response says `planOwnsExecution:true`, use `wait_for_decision` with the same `gameId` and `commandId` to observe that line's meaningful stop. If the line has stopped and you have no active decision, use ordinary `wait_for_decision` with the last observed cursor while play continues. `waitMs` bounds the first response wait. The game clocks keep running.

If the transport drops the receipt, repeat the identical `play_line` command ID and payload to recover in-process progress. When the engine acknowledgement itself is uncertain, reconcile the current game before any new command. A restart can expire the receipt. Unknown is not proof that nothing happened. Keep the decision loop active while waiting. Use `concede` when the position is lost and there are no plausible outs. The tool cancels the unapplied remainder before sending the concession.

## Compatibility

Older clients can still use `play_turn`, `play_sequence` or `submit_sequence` with the schemas they actually see. A legacy answer can use `expectCast` for a visible legal spell. A legacy guarded sequence stops at `turn_changed`. Legacy standalone `pass_until` actively declines optional plays within the observed turn and can continue through opponent responses. `END_TURN` is the engine's end step. After a legacy interruption, read the sequence receipt and fresh state, then replan only the unapplied part.
