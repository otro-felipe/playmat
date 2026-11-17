# Plan a turn

Play to win from your seat's view. For a London mulligan, prioritize castable early plays, usable colors, and a plan for the matchup. At very low hand sizes, keep a functional line instead of chasing the ideal hand. If you kept after a mulligan, answer the engine's prompt for the cards to put on the bottom.

At each meaningful priority window, decide who benefits if the game goes long. Check your mana, the opponent's available mana, life totals, combat math, immediate threats, and how your hand can use the next land drop. Consider how to make the opponent commit first, when to play around a likely response, and whether adding another threat exposes you to a sweeper. Compare the sequencing alternatives privately. Treat an inferred archetype or a possible response as a hypothesis.

## Execute a conditional line

Use `play_sequence` to queue up to twelve guarded choices, passes, or brief waits from the current `gameId` and `cursor`. Plan as far as you can justify from the visible state. After a draw, reveal, an uncertain resolution, or an opponent's response that could change the line, look again and replan.

- An `answer` needs an exact `decisionId` or a `guard` with the expected decision kind and a phase, step, or priority. Use exactly one `choiceId` or semantic `select`. Use a physical card ID when more than one choice matches a name.
- `expectCast: true` marks the planned cast. The plan can continue to payment for that same spell. Do not use it to approve unrelated additions to the stack.
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

Use `get_sequence_status` to learn where a background plan ended. A changed stack, unexpected prompt, reconnect, or rewind can invalidate the remainder. Read `get_game_state` to decide again. `cancel_sequence` stops unapplied steps. XMage owns the board and determines the actual legal choices.
