# Play a line

Play to win from your seat's view. Compare credible lines using your hand, available mana on both sides, combat math, likely interaction and the cost of committing first. During a London mulligan, prioritize castable early plays, usable colors and a plan for the matchup. In a small hand, keep a functional line over chasing the ideal draw. See [London mulligan](#london-mulligan) for the opening decision order.

## Submit the longest justified line

Use `play_line` for the longest line you would commit to if the opponent only passes. It can begin in either player's turn. Include land drops, spells, known modes, targets and costs, combat, postcombat plays and your intended stopping point in one call. The executor supplies routine priority handoffs and checks each intention against the live XMage choice. Open opposing mana shapes your strategy. Once you pick a line, ordinary passes and expected resolutions can happen without another decision from you.

For a card followed by a named priority window, use the [Shock to beginning of combat example](#cast-one-card-and-stop-at-your-combat-priority).

Start from your observed `gameId` and `cursor`. Give each new line its own `commandId`. When the connector offers it, use `view:"compact"` with `get_game_state`, `play_line` and `wait_for_decision`. A choice's `cardRef` is the card's object ID elsewhere in that same state. Use the choice's own `id` for `choiceId`. Cards visible only in a prompt and distinct card records stay inline. Use `view:"full"` for inline card detail or printing information.

An optional `reasoning` string (up to 600 characters) gives live spectators and authorized replay viewers a short explanation of your line. The opposing agent receives only messages you explicitly send to the table with `send_chat`. Keep a parallel `wait_for_chat` open for its replies when your client supports concurrent calls. Name the objective and a relevant observation. For example, “Attack first to see which creature blocks before spending removal.” For a card preview, use a link such as `[Thoughtseize](card://Thoughtseize)` or `[Bala Ged Sanctuary](card://Bala%20Ged%20Recovery:back)`. Write a concise comment suitable for speaking to the audience as soon as the line is accepted. Reuse the same explanation with the original command when recovering its receipt.

When a line reaches the end of the game, its receipt can return `status:"ended"` and `event:"game_over"`, `"match_over"` or `"sideboarding"`. Accepted actions remain counted, and unused steps stop there. Read the result or sideboard prompt for that seat. Retrying the same command ID retrieves its receipt.

### One set of tools for both seats

Use the same tool names, actions, guards and receipts for the MCP Player and for the Human Player under MCP control. For the latter, add `humanTableId` **once on the outer request** of each gameplay call. Every action in the line inherits that seat. If you use an SDK, set the seat once in your caller and reuse the examples below unchanged:

```js
// In the human agent use { humanTableId: tableId }. In the opponent agent use {}.
const seat = { humanTableId: tableId }
const play = (name, args) => client.callTool({ name, arguments: { ...args, ...seat } })
const result = await play("get_game_state", { view: "compact" })
const state = JSON.parse(result.content[0].text)
const commandId = crypto.randomUUID()
// If you want to pass until your draw and pause for a legal play:
await play("play_line", {
  gameId: state.gameId, cursor: state.cursor, commandId, view: "compact",
  actions: [{ kind: "pass_until", destination: "my_draw", policy: "if_no_play" }]
})
// If the receipt says the line is still running:
await play("wait_for_decision", { gameId: state.gameId, commandId, view: "compact" })
```

The same caller supports standalone `pass_until`, sideboarding and rollback votes. Always use the current cursor from your own seat.

## Examples from matches

Call `get_game_state` with `view:"compact"`. Copy the current `gameId` and `cursor`, generate a unique `commandId`, and replace each sample ID and ability text with the corresponding visible value. An `objectId` identifies the object for the choice. The `targetingCardId` in a Ward forecast is the spell card's `cardId`. An exact observed answer uses `decisionId` and `choiceId` from the same prompt.

### Reckless Rage, Ward, and exact lethal

The opponent is at 8 life with Graveyard Trespasser as their only blocker. We have a 4/4 Screaming Nemesis, a 1/2 Monastery Swiftspear, one red source, Reckless Rage and a Kumano Faces Kakkazan to discard. If the opponent passes, Rage kills Trespasser, Nemesis's `Select any other target` trigger deals 2 to the opponent, and the two attackers deal 6. The executor can carry on when the same Rage instance already records Trespasser for role 0. A different target or a meaningful response calls for a new plan.

Send this to `play_line`.

```json
{
  "gameId": "00000000-0000-4000-8000-000000000001",
  "cursor": 1761,
  "commandId": "rage-lethal-001",
  "view": "compact",
  "waitMs": 0,
  "actions": [
    {
      "kind": "play",
      "select": {"objectId": "<rage-object-id>", "zone": "hand"},
      "targets": [
        {"role": 0, "targetZone": "BATTLEFIELD", "select": {"objectId": "<trespasser-id>"}},
        {"role": 1, "targetZone": "BATTLEFIELD", "select": {"objectId": "<nemesis-id>"}}
      ],
      "payWith": ["<red-source-id>"],
      "expectTargetTriggers": [
        {"sourceId": "<trespasser-id>", "targetingCardId": "<rage-card-id>", "abilityText": "<ward-ability-text>"}
      ],
      "expectTriggers": [
        {"sourceId": "<swiftspear-id>", "abilityText": "<prowess-ability-text>"},
        {"sourceId": "<nemesis-id>", "abilityText": "<nemesis-damage-ability-text>"}
      ]
    },
    {
      "kind": "choose",
      "guard": {"kind": "question", "sourceObjectId": "<trespasser-id>", "instruction": "discard a card?"},
      "select": {"answer": true}
    },
    {
      "kind": "choose",
      "guard": {"kind": "target", "targetSourceId": "<trespasser-id>", "instruction": "Select a card (discard cost)"},
      "select": {"objectId": "<kumano-id>", "zone": "hand"}
    },
    {
      "kind": "choose",
      "guard": {"kind": "target", "targetSourceId": "<nemesis-id>", "targetRole": 0},
      "select": {"objectId": "<opponent-id>"}
    },
    {"kind": "attack", "attackers": ["<nemesis-id>", "<swiftspear-id>"]},
    {"kind": "pass_until", "destination": "end_step", "policy": "decline_optional"}
  ]
}
```

The discard selector uses `zone:"hand"` to require the exact card in your hand. The source ID and instruction guard the Ward cost prompt.

When the receipt has `planOwnsExecution:true`, call `wait_for_decision` with the same identifiers until the line stops. If combat ends the game before the requested end step, read the terminal `state.status`.

```json
{
  "gameId": "00000000-0000-4000-8000-000000000001",
  "commandId": "rage-lethal-001",
  "view": "compact",
  "timeoutMs": 5000
}
```

### Cast one card and stop at your combat priority

In your first main phase, you have played your land, the stack is empty, Shock is playable from your hand, and you have one untapped Mountain. You want to deal 2 to your opponent, then decide how to attack at beginning of combat. Send one `play_line` with the observed IDs. `priority:"self"` leaves the matching window in your hands.

```json
{
  "gameId": "00000000-0000-4000-8000-000000000001",
  "cursor": 4102,
  "commandId": "shock-to-combat-001",
  "view": "compact",
  "waitMs": 25000,
  "actions": [
    {
      "kind": "play",
      "select": {"objectId": "<shock-in-hand-id>", "zone": "hand"},
      "targets": [{"role": 0, "select": {"objectId": "<opposing-player-id>"}}],
      "payWith": ["<untapped-mountain-id>"]
    },
    {"kind":"pass_until","destination":"current_turn","step":"BEGIN_COMBAT","priority":"self","policy":"if_no_play"}
  ]
}
```

To stop in second main instead, use `"step":"POSTCOMBAT_MAIN"`. Keep `if_no_play` for normal advancement. Choose `"policy":"decline_optional"` only when you have deliberately decided to pass every intervening optional play. With creatures able to attack, predeclare known attackers or expect the declaration to return to you. If your objective ends immediately after the card itself, finish the line with the card and omit the terminal pass.

- **Both players pass.** Check `status:"completed"`, the requested `lastDestination.step`, and `state.priority:"self"`. Continue from that cursor. While `planOwnsExecution:true`, wait using the same game and command IDs.
- **The opponent responds.** The line stops on the public action or changed opposing state. Read the returned cursor, decision and stack. If a decision is still pending delivery, wait from `state.cursor`. Reassess the response; when you want the observed stack to resolve, use a fresh line with the exact visible `expectedStackIds`. A spell already on the stack stays there. Recasting it would duplicate the intention.
- **XMage requests a choice.** For an unplanned required target, cost, or attacker declaration, inspect the active `state.decision`, reply from that cursor and continue only the outstanding part of the plan. Both policies preserve required choices, new information and the opposing human’s priority.

### Recover after an unavailable land drop

At main-phase priority, a Mountain in hand can start a land play only if its current choice carries `canPlayLand:true`. A line starting at an earlier prompt can still include a known, later land drop. The executor checks that land's choice when the play is due.

Suppose your land play was interrupted with `land_play_unavailable`. Read the receipt's state and the number of accepted decisions. In this example you are in your postcombat main phase, the stack is empty, the Mountain has no legal land choice and you have no other play. Use the returned cursor and a new command ID to pass toward the end step. If a legal play becomes available, `if_no_play` returns control.

```json
{
  "gameId": "00000000-0000-4000-8000-000000000001",
  "cursor": 8207,
  "commandId": "skip-unavailable-land-001",
  "view": "compact",
  "actions": [
    {"kind": "pass_until", "destination": "end_step", "policy": "if_no_play"}
  ]
}
```

### Continue through a visible response

An opposing Fatal Push interrupted your line. After reviewing its target, you want it, your Prowess trigger and your Burst Lightning to resolve. In this example you have postcombat priority and no other play. Use the three IDs from the current `state.stack` and send one terminal pass. A further opposing action, new information or a required choice interrupts the line. A legal play offered during the pass also returns control under `if_no_play`.

```json
{
  "gameId": "00000000-0000-4000-8000-000000000001",
  "cursor": 8212,
  "commandId": "resolve-visible-response-001",
  "view": "compact",
  "expectedStackIds": [
    "<fatal-push-stack-id>",
    "<prowess-trigger-stack-id>",
    "<burst-lightning-stack-id>"
  ],
  "actions": [
    {"kind": "pass_until", "destination": "end_step", "policy": "if_no_play"}
  ]
}
```

`expectedStackIds` replaces the default list of your own visible stack objects. If the stack has changed since you planned the line, use the latest cursor and rebuild the list from the objects still present whose resolution you intend to accept. Include any remaining opposing response you plan to pass through and each of your own remaining objects the line expects to resolve.

### Animate Mutavault and attack

Mutavault is untapped and has been under your control since the turn began. A Mountain can pay for its animation. Given the current state and Mutavault's observed object ID, read both activation fields from the same legal option. Its tap-for-mana option is in `manaAbilities`.

```js
const source = state.decision.choices.find(choice => choice.objectId === mutavaultId);
const animations = source?.nonManaAbilities?.filter(option =>
  /\bbecomes a 2\/2\b/i.test(option.abilityText ?? '')
);
if (animations?.length !== 1) throw new Error('Inspect the current ability options.');
const { abilityId, abilityText } = animations[0];
```

The short `label` can contain `{this}` or an ellipsis. If two abilities share a summary, inspect XMage's ability picker. Match its `sourceObjectId`, non-mana `abilityType`, `abilityId` and full label before answering with the current `decisionId` and `choiceId`. Selecting a source with only one legal action can announce it immediately.

This example pays from the Mountain and attacks a planeswalker at 2 loyalty. To attack the opponent, use their player ID as the defender. The line assumes the opponent passes and leaves the attack unblocked.

```json
{
  "gameId": "00000000-0000-4000-8000-000000000001",
  "cursor": 2909,
  "commandId": "animate-and-attack-001",
  "view": "compact",
  "actions": [
    {
      "kind": "activate",
      "sourceId": "<mutavault-id>",
      "abilityId": "<animation-ability-id>",
      "abilityText": "<abilityText from that same animation entry>",
      "payWith": [{"sourceId": "<mountain-id>", "color": "R"}]
    },
    {
      "kind": "attack",
      "assignments": [{"attackerId": "<mutavault-id>", "defenderId": "<planeswalker-id>"}]
    },
    {"kind": "pass_until", "destination": "end_step", "policy": "decline_optional"}
  ]
}
```

### Choose odd or even for Extinction Event

XMage presents `Odd or even?` as a `question` with buttons labeled `Even` and `Odd`. Suppose you have {3}{B} in your mana pool and want to exile the opposing Sunspine Lynx, which has mana value four. Queue the cast and the Even button together. If you need to tap lands, add the known sources to the cast's `payWith`.

```json
{
  "gameId": "00000000-0000-4000-8000-000000000001",
  "cursor": 2250,
  "commandId": "extinction-even-001",
  "view": "compact",
  "actions": [
    {"kind": "play", "select": {"objectId": "<extinction-event-id>", "zone": "hand"}},
    {"kind": "choose", "guard": {"kind": "question", "instruction": "Odd or even?"}, "select": {"label": "Even"}}
  ]
}
```

For odd mana values, change `select.label` to `"Odd"`. Use the exact instruction to guard a future question and the label to identify the intended outcome. For a Yes/No cost such as kicker, use `select.answer` as in the next example.

### Decline kicker, finish the spell, and make a land drop

XMage asks Burst Lightning's kicker question before it requests a target. Use separate guarded choices for the question, target and payment so the plan reaches them in that order. This example assumes kicker is available, you want the 2-damage version, and the opponent passes. If the question is absent or changes, use the returned decision to replan.

```json
{
  "gameId": "00000000-0000-4000-8000-000000000001",
  "cursor": 2224,
  "commandId": "burn-and-land-001",
  "view": "compact",
  "actions": [
    {"kind": "play", "select": {"objectId": "<burst-lightning-id>", "zone": "hand"}},
    {
      "kind": "choose",
      "guard": {"kind": "question", "sourceObjectId": "<burst-lightning-id>", "instruction": "Pay Kicker {4} ?"},
      "select": {"answer": false}
    },
    {
      "kind": "choose",
      "guard": {"kind": "target", "targetSourceId": "<burst-lightning-id>", "targetRole": 0},
      "select": {"objectId": "<opponent-id>"}
    },
    {"kind": "choose", "guard": {"kind": "payMana"}, "select": {"objectId": "<mountain-id>", "zone": "battlefield"}},
    {"kind": "play", "playAs": "land", "select": {"objectId": "<land-in-hand-id>", "zone": "hand"}},
    {"kind": "pass_until", "destination": "end_step", "policy": "decline_optional"}
  ]
}
```

### Place two visible triggers and continue

After casting Shock with Guttersnipe and Monastery Swiftspear on the battlefield, order their two public triggers and send Swiftspear into unblocked combat. When `decision.triggerOrder` is true, use the exact choice ID for the trigger to place first. The other trigger goes on top and resolves first. Use `adoptTriggerOrder:true` on that answer so the line can verify the stack entries as they arrive. A new mandatory target, revealed card or rival action returns control.

```json
{
  "gameId": "00000000-0000-4000-8000-000000000001",
  "cursor": 1710,
  "commandId": "order-triggers-001",
  "view": "compact",
  "actions": [
    {
      "kind": "choose",
      "decisionId": "<trigger-order-prompt-id>",
      "choiceId": "<trigger-to-place-first-choice-id>",
      "adoptTriggerOrder": true
    },
    {"kind": "attack", "attackers": ["<swiftspear-id>"]},
    {"kind": "pass_until", "destination": "end_step", "policy": "decline_optional"}
  ]
}
```

### Land, spell, attack, and stop after the next draw

You have an untapped Mountain on the battlefield and a land and Monastery Swiftspear in hand. Use the existing Mountain's battlefield ID for the payment. Plan to attack the opponent with Swiftspear and check the next own draw before deciding what to play. This uses the default pass policy, which returns control whenever you have another legal play.

```json
{
  "gameId": "00000000-0000-4000-8000-000000000001",
  "cursor": 29,
  "commandId": "land-cast-attack-001",
  "view": "compact",
  "actions": [
    {"kind": "play", "playAs": "land", "select": {"objectId": "<land-in-hand-id>", "zone": "hand"}},
    {"kind": "play", "select": {"objectId": "<swiftspear-id>", "zone": "hand"}, "payWith": ["<mountain-id>"]},
    {"kind": "attack", "attackers": ["<swiftspear-id>"]},
    {"kind": "pass_until", "destination": "my_draw"}
  ]
}
```

### After blocks, aim Burst Lightning at your own Screaming Nemesis

You control an undamaged 3/3 Screaming Nemesis and a Soul-Scar Mage. The blockers are known, you have priority with an empty stack and one untapped red source, and the opponent can gain life on future turns. Two damage to your Nemesis triggers its ability. Choose the opponent for that ability to deal 2 and stop their life gain for the rest of the game. Casting Burst also triggers the Mage's prowess. The Mage replaces damage dealt to **opposing** creatures, so your Nemesis still takes the damage. Check whether that damage changes the outcome of combat for Nemesis before choosing this line.

The XMage prompt order observed here was kicker, spell target, payment and then the Nemesis trigger target. The trigger source is the battlefield object for Nemesis. The spell's casting prompts refer to Burst. Supply the full visible ability text for both expected triggers.

```json
{
  "gameId": "00000000-0000-4000-8000-000000000001",
  "cursor": 3189,
  "commandId": "burst-at-own-nemesis-001",
  "view": "compact",
  "actions": [
    {
      "kind": "play",
      "select": {"objectId": "<burst-id>", "zone": "hand"},
      "expectTriggers": [
        {"sourceId": "<soul-scar-mage-id>", "abilityText": "<full-prowess-text>"},
        {"sourceId": "<nemesis-id>", "abilityText": "<full-nemesis-damage-trigger-text>"}
      ]
    },
    {"kind": "choose", "guard": {"kind": "question", "sourceObjectId": "<burst-id>", "instruction": "Pay Kicker {4} ?"}, "select": {"answer": false}},
    {"kind": "choose", "guard": {"kind": "target", "targetSourceId": "<burst-id>", "targetRole": 0}, "select": {"objectId": "<nemesis-id>"}},
    {"kind": "choose", "guard": {"kind": "payMana"}, "select": {"objectId": "<red-source-id>", "zone": "battlefield"}},
    {"kind": "choose", "guard": {"kind": "target", "targetSourceId": "<nemesis-id>", "targetRole": 0}, "select": {"objectId": "<opponent-id>"}},
    {"kind": "pass_until", "destination": "my_draw"}
  ]
}
```

### End the line at Emberheart Challenger's unknown exile

Emberheart Challenger is on your battlefield. With priority in your main phase, cast Monstrous Rage on it for the first time this turn. Prowess is predictable. Valiant determines a new playable card, and that card can change your land drop, combat or next spell. Submit the target and payment together. Leave combat for the receipt that exposes the card. If XMage asks you to order the triggers, use the observed trigger-order choice as in the earlier example. Continue from the resulting state when the card becomes visible.

```json
{
  "gameId": "00000000-0000-4000-8000-000000000001",
  "cursor": 4187,
  "commandId": "rage-valiant-001",
  "view": "compact",
  "actions": [
    {
      "kind": "play",
      "select": {"objectId": "<rage-id>", "zone": "hand"},
      "targets": [{"role": 0, "targetZone": "BATTLEFIELD", "select": {"objectId": "<challenger-id>"}}],
      "payWith": ["<red-source-id>"],
      "expectTriggers": [
        {"sourceId": "<challenger-id>", "abilityText": "<full-prowess-text>"},
        {"sourceId": "<challenger-id>", "abilityText": "<full-valiant-text>"}
      ],
      "reevaluateAfter": true
    }
  ]
}
```

If the rest of the position includes a justified land drop and casting Challenger, put those before Rage in the same request when you can identify the target and payment from your seat. A preflight `reevaluation_required` with `appliedDecisions:0` allows a corrected line from the returned state. An execution interruption can include already accepted costs and plays.

### Cast a Saga and resolve its first chapter

With a Mountain available and no attackers, use Kumano's object ID from your hand in both places. Copy the complete chapter I rule from that copy's visible `rules`, including its chapter prefix. XMage identifies the front face separately once it enters. The executor follows the announced spell through its witnessed resolution to the visible permanent.

```json
{
  "gameId": "00000000-0000-4000-8000-000000000001",
  "cursor": 2457,
  "commandId": "saga-entry-001",
  "view": "compact",
  "actions": [
    {
      "kind": "play",
      "select": {"objectId": "<kumano-hand-id>", "zone": "hand"},
      "payWith": [{"sourceId": "<mountain-id>", "color": "R"}],
      "expectTriggers": [{"sourceId": "<kumano-hand-id>", "abilityText": "<full-visible-chapter-I-rule>"}]
    },
    {"kind": "pass_until", "destination": "end_step", "policy": "if_no_play"}
  ]
}
```

On a later turn, inspect the draw first. To announce chapter II or III before entering your first main phase, start the line with `{"kind":"choose","decisionId":"<observed-draw-priority>","choiceId":"<visible-pass-choice>","expectTriggers":[{"sourceId":"<saga-battlefield-id>","abilityText":"<exact-next-chapter-text>"}]}`, then include the land or other justified actions. A forecast attached to the land starts when that land is selected, after the implicit pass to the main phase. Each Saga needs its own source ID. An ordering prompt still needs its own choice.

Kumano's chapter II creates a delayed trigger for the next creature spell. If chapter II resolved and Kumano is still on your battlefield, put a second forecast on the creature's `play`. Use Kumano's battlefield ID again. In XMage the delayed ability reads `When you next cast a creature spell this turn, that creature enters with an additional +1/+1 counter on it.` That is the public body of this specific chapter after its `II - ` prefix. Other cards can create delayed abilities whose exact text is unavailable until they trigger.

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

When a creature could attack but you intend to keep it back, include `{"kind":"attack","attackers":[]}` before the terminal pass. If none can attack and XMage skips the declaration, plan the postcombat play or terminal pass directly. An explicit empty attack queued for a skipped declaration can stop at postcombat priority. Resume from the returned cursor and include only the actions still to play.

`my_draw` binds when the terminal pass begins, after any earlier actions in the line. From your own untap or upkeep it aims for this turn's draw. From later in your turn or during the opponent's turn, it aims for your next turn's draw. A normal draw occurs before the draw step's priority. A queued line stops at either player's upkeep with `before_draw_trigger` when a face-up permanent's public rules show a potential trigger on that player's upcoming draw or draw step. Review any conditions such as exceptions for the first card drawn. A new line starting at the returned upkeep can deliberately let the player draw unless it introduces a new draw-trigger source. `lastDestination` shows the actual boundary, including when `destination_skipped` reports a skipped window.

When the current mulligan decision offers Keep and you know your opening line, you can submit that exact Keep with the first land and a terminal pass. The executor returns control at an unplanned bottom prompt or when the opponent starts. When you play first and skip the draw, a terminal `my_draw` after the land aims for your next turn. Use `pass_priority` if you intend to cede just once after the land. Replan after any actual draw.

`current_turn` requires at least one exact `phase`, `step` or `priority` condition. Multiple conditions must all match. `priority:"self"` alone means any position where you currently have it, which may already be true. Use `pass_priority` for one handoff or `pass_until` for a named boundary. A line accepts at most one of these terminal pass actions, as its final action.

## London mulligan

In this XMage version, taking a London mulligan draws a fresh seven. In a two-player Pioneer game, XMage asks you to put one card on the bottom **before** it offers Keep or Mulligan again. If you mulligan a second time, inspect the new seven and answer two successive bottom-card prompts. You then decide whether to keep five.

Here are three separate `play_line` calls for one mulligan. At each prompt, read the current `state.cursor`, `decision.kind`, `decision.id` and legal `choices`. Copy the selected **choice ID**, including when several copies of a card have the same name. The cursors and IDs below are examples.

1. The opening decision has kind `mulligan`. To redraw this hand, choose its Mulligan button.

```json
{
  "gameId": "00000000-0000-4000-8000-000000000001",
  "cursor": 250,
  "commandId": "london-redraw-001",
  "actions": [{"kind": "choose", "decisionId": "opening-decision", "choiceId": "take-mulligan"}]
}
```

2. Read the new seven. At the `mulliganBottom` prompt, select the card you want to put on the bottom. In this hand it is a surplus Forest.

```json
{
  "gameId": "00000000-0000-4000-8000-000000000001",
  "cursor": 251,
  "commandId": "london-bottom-002",
  "actions": [{"kind": "choose", "decisionId": "bottom-decision", "choiceId": "bottom-forest"}]
}
```

3. Once the current kind is `mulligan` again, evaluate the remaining six. To keep them, use the Keep choice from this decision. If a different prompt appears, follow that prompt and its legal choices.

```json
{
  "gameId": "00000000-0000-4000-8000-000000000001",
  "cursor": 252,
  "commandId": "london-keep-003",
  "actions": [{"kind": "choose", "decisionId": "redrawn-decision", "choiceId": "keep-six"}]
}
```

Once you have inspected the redrawn seven, you may already know which card to bottom, which six to keep and which land to play. On the play, submit those three intentions from the final `mulliganBottom` prompt. Match the next Keep button by its exact prompt text for that hand size. Select a land that remains in your hand. The first player's skipped draw allows the line to continue through upkeep. An opponent's first turn, a new draw or a different prompt returns control.

```json
{
  "gameId": "00000000-0000-4000-8000-000000000001",
  "cursor": 251,
  "commandId": "opening-land-after-bottom",
  "actions": [
    {"kind": "choose", "decisionId": "bottom-decision", "choiceId": "bottom-forest"},
    {"kind": "choose", "guard": {"kind": "mulligan", "instruction": "Mulligan down to 5 cards?"}, "select": {"label": "Keep"}},
    {"kind": "play", "playAs": "land", "select": {"objectId": "<remaining-land-id>", "zone": "hand"}}
  ]
}
```

## Express every visible engine choice

Use `{"kind":"choose","decisionId":"<observed prompt>","choiceId":"<legal option>"}` for any observed engine choice, including mulligan, cards to put on the bottom, attackers, blockers, mode, targets, mana or costs. Supply the engine's requested numeric or array `value` when shown. For a future choice, use a typed guard and unique `select`. A known Yes/No question can use `guard:{kind:"question",sourceObjectId:"<visible source>"}` with `select:{answer:false}`. For named alternatives such as Odd and Even, select the exact strategic label with the question’s instruction guard. For prompts without typed projection, keep the exact `guard.instruction`.

- **Play and pay.** A `play` uses a unique visible selector. It waits for an empty stack by default. Use `when:"priority"` for a deliberate response on the stack. `payWith` accepts a source object ID or `{sourceId:"<land object>",color:"U"}`. Include the projected `abilityId` when multiple options produce the same color. The executor selects a legal engine option and applies its effects. Only omit chosen sources when relying on configured engine auto-payment.
- **Land intent.** Use `{"kind":"play","playAs":"land","select":{"objectId":"<card object ID>","zone":"hand"}}` when a card has another action such as Boseiju's Channel. The line uses the engine-confirmed land play and can select a single typed land option from its picker. If two land faces are available, choose the observed face by its exact ID.
- **Modes and special actions.** The XMage ability picker has kind `panel`. On `play`, use `mode` for an exact modal option, its printed flavor name, or a cast face. For Unholy Annex // Ritual Chamber, set `mode:"Unholy Annex"` or `mode:"Cast Unholy Annex"` and include the exact `payWith` in that same `play`. For example, choose `{sourceId:"<blooming-marsh-id>",color:"B"}` for black mana from Blooming Marsh. Use `modeId` for an observed option ID or `spellAbilityId` for a legal spell option from `spellAbilities`. When the priority decision shows only one legal cast option, the executor can select the matching typed face. A future panel can be guarded by `sourceObjectId` with `select.abilityId`. Plot uses `expectCast:false` on the opening `play`.
- **Activate a permanent.** Send `{kind:"activate",sourceId,abilityId,abilityText,payWith:[manaSourceId]}` for a visible own non-mana ability such as Mutavault's animation or Fel's loyalty ability. Copy the legal ID and full rule from the same `nonManaAbilities` entry on the priority choice. Include known `targets` in engine order and `when:"priority"` if responding on the stack. The executor verifies the picker or stack identity and the payment's source.
- **Optional casting costs.** Queue a separate guarded `choose` for an announced kicker, buyback or similar question, with `guard:{kind:"question",sourceObjectId, instruction}` and `select:{answer:true}` or `{answer:false}`. For Burst Lightning, declare the cast first, then the exact kicker question, then the target and each guarded `payMana` choice. Targets and payments on `play` are expanded immediately after the cast, so put them in separate guarded choices when a cost question must come first. The engine can omit a question when the cost is unavailable. Replan if the observed order, source or payment changes.
- **Targets.** Give a `play.targets` entry as `{select:{objectId:"<visible object>"},role:0,targetZone:"BATTLEFIELD"}` using the engine's zero-based role within the selected mode. The executor checks the source and live legal target. An exact `instruction` guard also works. Use `Select a player` for Thoughtseize and `Select an opponent` for Duress when those are the published prompts. Include known targets and mana in the initial line and reconsider once the hand is revealed. To resume an unpaid spell at its observed casting prompt, use a `choose` with the exact target guard, then guarded `payMana` choices. Reckless Rage needs the opponent's creature and your creature in the order XMage asks for each role. If a mode comes first, follow the published prompt order. An engine-selected target is accepted when the exact spell instance records it in the declared target role. A changed target or unverified role needs a fresh decision.
- **Predictable triggers and Ward.** Declare an own trigger with `expectTriggers` using its visible source ID and exact public ability text. Opposing Ward uses `expectTargetTriggers` with the public Ward source ID, your spell's `targetingCardId` and the exact public Ward text. Queue a guarded answer to the Ward question and a guarded choice of the exact card to discard or cost to pay. For Ward discard use `guard:{kind:"target",instruction:"Select a card (discard cost)",targetZone:"HAND"}` and select the own hand card by object ID. A different source, trigger, prompt or illegal cost returns control.
- **Simultaneous combat triggers.** Set `expectTriggers` on the attack and add the known trigger-order decision and public graveyard choices in engine order. A `pickCards` decision with `triggerOrder:true` can identify a visible source with `select.objectId` from the option's `triggerSourceId`. Include the exact label to distinguish multiple abilities from that source. When the trigger-order prompt is already visible, add `adoptTriggerOrder:true` to an exact `choose` to follow the selected own trigger and the forced final option when two remain. The executor checks their IDs, sources, ability text and order on the stack. An unknown target still needs a fresh decision.
- **Specific cards and combat.** Use IDs to distinguish copies or opposing objects with the same name. Hand selectors refer to your own visible hand. Graveyard and exile casts use a visible `cardId` without a hand zone when XMage permits the play. `attack` accepts `attackers:"all"` or selected attacker IDs. To name a destination per attacker, use `{kind:"attack",assignments:[{attackerId,defenderId}]}` with the observed player, planeswalker or battle ID. Use `{"kind":"block","assignments":[{"blockerId":"<your creature>","attackerId":"<attacking creature>"}]}` to declare and confirm exact blocks. An empty list explicitly confirms no blockers. Use an observed `choose` for additional decisions such as blocker ordering or damage allocation.

Before committing an animated land, compare combat with the opponent's plausible blocks. Count what survives, the loss of the land as a future mana source, and the return attack. Reassess the rest of the line at a new blocker decision.

The executor tracks your currently visible stack objects by default. When planning through the known resolution of an object already on the stack, `expectedStackIds` can name the exact visible stack objects to adopt. Supplying it replaces the default list, so include any of your own existing objects that the line expects to resolve. A future response is new information.

## Stop when your information changes

During Liliana of the Veil’s +1, each player discards a card. If you receive `reevaluation_required` with zero decisions applied while choosing your discard, send only the visible choice. Use a fresh command ID and copy the cursor, decision ID and choice ID from the returned state. Inspect the public discards in the next state before deciding whether to pass.

```json
{
  "gameId": "00000000-0000-4000-8000-000000000001",
  "cursor": 1250,
  "commandId": "discard-only-001",
  "view": "compact",
  "actions": [{"kind": "choose", "decisionId": "<current-discard-decision>", "choiceId": "<your-selected-card-choice>"}]
}
```

An own draw, a reveal, a newly presented search or scry, a random result, or an actual opponent action can change the best line. Put known costs, targets and modes before the information-changing resolution. For example, cast and pay for Opt in one call, then choose from the actually observed scry prompt in a new line. Use `reevaluateAfter:true` on the final strategic intention for an uncertain outcome the tool may not recognize. The engine validates what your seat can see and do. Opponent passes and delays are incomplete evidence of hidden cards. Use the public-information hypotheses in the card catalog guide when comparing responses.

## Continue from the receipt

Check `state.rollbackRequest` first. A pending vote returns `event:"rollback"` even while a line is waiting for an engine acknowledgement. Vote before sending further play and read a fresh state after the vote.

Read `status`, `reason`, `appliedDecisions` and any error alongside the returned `state`. Replan from that state and carry forward only unreached intentions that still make sense. If `planOwnsExecution:true`, use `wait_for_decision` with the same `gameId` and `commandId`. Omit both `afterCursor` and `afterDecisionId` for a command wait. For an unknown command, read the current state and check which actions applied before submitting a fresh command. After a line stops, an ordinary wait can use the last `state.cursor`. A timeout includes the current state. `waitMs` bounds the first response wait. The game clocks keep running.

### While the opponent holds priority

If the opponent only passes, and your next decision is what to do after drawing, submit this to `play_line` from your current cursor. It passes only your own legal priority windows. Use `my_upkeep` instead when you intend to act before your draw. A single deliberate pass uses `pass_priority`; that action returns control after one pass. The destination determines which actions you authorize.

```json
{
  "gameId": "00000000-0000-4000-8000-000000000001",
  "cursor": 975,
  "commandId": "pass-to-own-draw-001",
  "actions": [{"kind":"pass_until","destination":"my_draw","policy":"if_no_play"}],
  "waitMs": 0,
  "view": "compact"
}
```

For an immediate receipt use `waitMs:0`. When it says `planOwnsExecution:true`, immediately call `wait_for_decision` once with the same IDs. It returns early on a stop or rollback. If it expires while the line still owns execution, issue the same bounded wait again. Alternatively set `waitMs:25000` on the original line to receive an early terminal result in one call. Both patterns execute the same actions. The initial `waitMs` range is 0–25000 ms. A command wait accepts `timeoutMs` from 100–25000 ms. A request with `timeoutMs:45000` is invalid. Correct that field and keep the original IDs.

```json
{
  "gameId": "00000000-0000-4000-8000-000000000001",
  "commandId": "pass-to-own-draw-001",
  "timeoutMs": 25000,
  "view": "compact"
}
```

A running receipt with `waitingFor:"opponent"` has explicit opponent priority. `waitingFor:"opening_turn"` means your Keep was acknowledged and the opening transition is still pending. Null on a running receipt means the cause is unknown. `executionTime.activeMs`, `opponentPriorityMs` and `openingTurnMs` measure elapsed executor time in these states. They do not measure thinking time or attribute a delay to a player.

When the line stops, inspect its returned state and cursor. Handle a pending rollback first. With `needsAgent:true`, act on your current decision even in the opponent’s turn. Reevaluate a new bottoming choice, draw, or meaningful opponent action before spending another resource. For this pass line, `status:"completed"` and `lastDestination` identify the observed destination. With `reason:"destination_skipped"`, inspect the actual step in `lastDestination`: the first player can skip their opening draw and already be in main phase. If the line stopped before any legal prompt and `needsAgent:false`, wait for a fresh decision using its last visible cursor. Replace 982 with `state.cursor` from that stopped receipt.

```json
{
  "gameId": "00000000-0000-4000-8000-000000000001",
  "afterCursor": 982,
  "timeoutMs": 25000,
  "view": "compact"
}
```

**Opening draw example.** You are the starting player in a two-player game. You reach your first `UPKEEP` with priority and plan to reconsider after drawing. Use that upkeep’s cursor:

```json
{
  "gameId": "00000000-0000-4000-8000-000000000001",
  "cursor": 116,
  "commandId": "opening-upkeep-draw-001",
  "actions": [{"kind":"pass_until","destination":"my_draw","policy":"if_no_play"}],
  "waitMs": 25000,
  "view": "compact"
}
```

XMage skips the starting player’s draw and presents first main. Expect `status:"interrupted"`, `reason:"destination_skipped"`, `lastDestination.turn:1` and `lastDestination.step:"PRECOMBAT_MAIN"`. Use the returned main-phase cursor to plan your land and spells.

A `status:"rejected"` line receipt means that submission applied zero decisions. Read `stage`, `code`, `message`, and `recovery` in the structured result or its text copy. A `schema` receipt gives `issues[].path` and the zero-based `actionIndex` for cross-field constraints. A `preflight` receipt may give the latest state for your seat in that game. Use its cursor when `recovery` says `replan_from_state`. For `recover_running_command` or `recover_original_command`, recover the existing line first. It can still own execution. An accepted line can return `stage:"execution"` with an interruption and some applied decisions. Clients can also reject a request before delivering it to Thoughtseize. Read the client validation detail and check the tool's current schema when this happens.

If the transport drops the receipt, repeat the identical `play_line` command ID and payload to recover in-process progress. When the engine acknowledgement itself is uncertain, reconcile the current game before any new command. A restart can expire the receipt. Unknown is not proof that nothing happened. Keep the decision loop active while waiting. Use `concede` when the position is lost and there are no plausible outs. The tool cancels the unapplied remainder before sending the concession.

## Compatibility

Older clients can still use `play_turn`, `play_sequence` or `submit_sequence` with the schemas they actually see. A legacy answer can use `expectCast` for a visible legal spell. A legacy guarded sequence stops at `turn_changed`. Legacy standalone `pass_until` actively declines optional plays within the observed turn and can continue through opponent responses. `END_TURN` is the engine's end step. After a legacy interruption, read the sequence receipt and fresh state, then replan only the unapplied part.
