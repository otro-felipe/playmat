# MCP pilot context budget

**Date:** 24 November 2026. **Evidence:** the native JSONL of the Claude Opus 5.5 pilot (Mono-Red, profile `f4325d26…`) in the two-game Pioneer match `ddb997f8-3653-4b5e-83a3-55d9bee211e8` against Felipe on production, plus the guide bundle served by the same revision. The human seat used the web client and has no JSONL.

## What the pilot paid for

| Measure | Value |
| --- | ---: |
| Tool result text, whole match | 2.30 M characters |
| `play_line`: 117 calls | 2.03 M (17.4 KB average) |
| `wait_for_decision`: 7 calls | 53 KB (7.6 KB average) |
| Model turns / cache-read input / output | 260 / 112 M tokens / 185 k tokens |
| Peak context | ~967 k tokens (compaction required) |
| `get_guide({"bundle":true})` | 124.6 KB, over the client limit; read back through 7 `Read` calls (206 KB) |

The pilot already requested `view:"compact"` on every call. In those compact state responses:

| Field | Share |
| --- | ---: |
| `state.players` (battlefield 587 KB, graveyard 349 KB, exile 15 KB) | 1.01 MB |
| `state.decision` (`choices[].card` 132 KB, `payWithOptions` 50 KB, `manaAbilities` 31 KB, `playLineAction` 24 KB) | 386 KB |
| `state.sequenceEvidence` (`combatDamage` 183 KB, growing each response; `resolutions` 85 KB) | 301 KB |
| `rules[]` on battlefield and graveyard cards | 298 KB |
| `id`, `cardId`, `controllerId` on battlefield and graveyard cards (nearly always equal or derivable) | 3 × 85 KB |
| `timing.warning`, the same sentence each time | 26 KB |

88% of zone-object characters were byte-identical to the same object in the previous response, and 98% of `rules[]` text repeated text already sent for that card name. Choices repeated their card inline because the own-battlefield copy carried the executor-only `zoneChangeCounter`, so the deep-equality reference test failed.

## Options

| Option | Saving | Risk | Decision |
| --- | --- | --- | --- |
| Rules on first sight per game, resent by `get_game_state` | Largest single cut (~300 KB) | A pilot that loses context must re-read the state; the receipt says so in `rulesOmitted` | **Implemented** |
| Drop derivable fields: `cardId` = `id`, zone owner `controllerId`, zero damage, `tapped:false`, empty lists, zero P/T of non-creatures, executor incarnation fields | ~250 KB | None: values are implied by position or type | **Implemented** |
| Keep only revision counters in `sequenceEvidence` | ~290 KB | None for the pilot: the executor reads the full snapshot; the guides never use the ledgers | **Implemented** |
| `timing.warning` once per game while unchanged | 26 KB | The deadline itself stays in every response | **Implemented** |
| Choice `cardRef` compared on normalized copies; plain single-colour mana choices without `payWithOptions`/`manaAbilities` | ~200 KB | Prompts whose card truly differs stay inline (PM-VIEW-02) | **Implemented** |
| Opponent graveyard as names and counts | Small after first-sight rules | Graveyard IDs are targets (Bitter Triumph, delve, escape) | Rejected: rules omission already removes most of it |
| Delta responses keyed to the cursor (changed objects + removed IDs) | Most of what remains | A lost or reordered receipt corrupts the pilot's model; needs a resync contract and client discipline | Deferred: recommended next step once pilots run a client-side state store |
| Embed fewer `playLineAction`s | 24 KB | Guides copy them for discrete prompts | Rejected |

**Recommendation:** ship the compact trimming as the gameplay default for `view:"compact"` (done here, backward compatible: every ID, legal choice and public number stays), and evaluate cursor deltas only with a client that keeps state.

## Results

`scripts/measure-compact-view.mjs <pilot.jsonl>` replays every recorded state response through the current compact view, resetting the memory on each `get_game_state`:

| | Before | After |
| --- | ---: | ---: |
| 121 `play_line`/`wait_for_decision` state responses | 2,034 KB | 847 KB |
| Average per response | 16.8 KB | 7.0 KB (−58%) |
| Scripted whole game from compact receipts (`compact-game.test.mjs`) | — | 2.4 KB average, every visible card's rules already delivered |
| Startup `get_guide({"bundle":true})` | 124.6 KB | 11.2 KB |
| Handshake instructions | 4.1 KB | 3.4 KB |

The startup bundle now holds one `core` guide: the decision loop, compact-view facts, a schema-checked minimal `play_line` for each common shape (keep, target guard, kicker with `optionalCosts`, attack `assignments` with `defenderId`, top-level `expectedStackIds`, terminal pass) and a table of every stop code with its next call. `getting-started`, `turn-planning`, `card-catalog` and `rules` load by `guideId`. The handshake no longer repeats the play-loop and timing paragraphs that the core guide carries.

## Related contract changes from the same review

- Automatic passes let rival triggers from sources public at line start resolve (Sheoldred, emblems), and the upkeep draw-trigger stop fires only when the seat can act. In the match these two causes produced 35 of 79 interruptions.
- Player views list public command-zone objects (`players[].command`).
- `send_chat` after a game ends returns `chat_closed`; XMage deletes a game's chat when the game ends.
