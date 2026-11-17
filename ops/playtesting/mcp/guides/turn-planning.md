# Plan a turn

Play to win from your seat's view. For a London mulligan, prioritize castable early plays, usable colors, and a plan for the matchup. At very low hand sizes, keep a functional line instead of chasing the ideal hand. If you kept after a mulligan, answer the engine's prompt for the cards to put on the bottom.

At each meaningful priority window, decide who benefits if the game goes long. Check your mana, the opponent's available mana, life totals, combat math, immediate threats, and how your hand can use the next land drop. Consider how to make the opponent commit first, when to play around a likely response, and whether adding another threat exposes you to a sweeper. Compare the sequencing alternatives privately. Treat an inferred archetype or a possible response as a hypothesis.

## Execute a conditional line

Use `play_sequence` to queue up to twelve guarded choices, passes, or brief waits from the current `gameId` and `cursor`. Plan as far as you can justify from the visible state. After a draw, reveal, an uncertain resolution, or an opponent's response that could change the line, look again and replan.

- An `answer` needs an exact `decisionId` or a `guard` with the expected decision kind and a phase, step, or priority. Use exactly one `choiceId` or semantic `select`. Use a physical card ID when more than one choice matches a name.
- `expectCast: true` marks the planned cast. The plan can continue to payment for that same spell. Do not use it to approve unrelated additions to the stack.
- `hold` waits up to ten seconds inside a decision. Use it sparingly and account for the match clock.
- `pass_until` advances only by passing legal opportunities in the observed state. Set the phase, step, or priority you want to reach. By default, the sequence can stop for a meaningful response. Leave optional responses enabled unless you explicitly want to pass them. Use `wait_until` to observe a destination without passing.

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
