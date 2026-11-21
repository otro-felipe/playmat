# Cards and matchups

Use `get_card` for a known `name` and optional `setCode`, `cardNumber`, or `format`. Read the card's rules text, costs, types, and printing. Check every relevant face before relying on a card's characteristics.

Use `search_cards` when you know features instead of a name. This example finds Pioneer blue instants with mana value at most two and a recognized keyword:

```json
{"format":"Pioneer","colors":["U"],"maxManaValue":2,"types":["INSTANT"],"keywords":["Surveil"]}
```

`colors` matches any requested color; `manaSymbols` and `keywords` each require every requested term. Use `nextOffset` if another source page is available. Keywords are a guide to the catalog's text, so inspect the actual cards for timing, additional or alternative costs, and target restrictions. A card's color and mana value need not equal the mana required to cast it.

Use `list_archetypes` for dated public examples. With a suspected archetype and available mana, use `find_possible_responses` with `format`, `archetype`, and relevant search filters. Check the provenance and `inPublicSample` flag, then decide which possibilities matter now. For example, look for instant-speed interaction, but also check relevant activated abilities on public permanents and the possibility of reduced or alternate costs. The result tells you what might be played. It has no access to the opposing player's hand or deck.

For your own deck, use `validate_deck` where authorized to check the whole list against XMage. For dated format policies and bans beyond the pinned engine's catalog, consult [Wizards' banned and restricted list](https://magic.wizards.com/en/banned-restricted-list).

## Track an opponent response range

Keep a small private, per-game ledger of the few responses that could change your next decision. Separate known public facts, hypotheses and unknowns. A useful row is `response/card family | public basis | last meaningful opportunity | observed action/pass | confidence trend | alternative explanation | consequence for our line`. Use qualitative trends (plausible, less likely, still unknown), not invented percentages. Do not infer that a card is absent just because it was not played.

1. Generate candidates from the format, observed colors/cards, public archetype samples and public permanents. `find_possible_responses` supplies possibilities, not the opponent's actual list. Never inspect opposing hidden hands/libraries, private saved decks, private server diagnostics or another seat's view to refine the range. Authorized history or replays may support public facts only through your seat's permitted, redacted view. A revealed card is known only while public history still supports its location; a new game resets hand hypotheses.
2. Before treating a pass as negative evidence, check that the candidate would have been legal at that timing, could plausibly be paid for (including alternate costs), had a useful target, and offered a strong reason to act. Confirm that the opponent actually had and yielded priority. A skipped or unobserved window, tool latency, disconnect, inactivity or an automatic pass is not evidence of card absence.
3. Reduce confidence modestly after a genuinely informative nonresponse. Keep alternatives: saving interaction for a stronger threat, different targets or timing, bluffing, a different plan, or a mistake. Several distinct high-incentive opportunities can strengthen the update; repeated observations of the same opportunity are not independent evidence. Open mana is not proof of interaction, and tapped lands do not rule out free spells or abilities.
4. Reassess after every relevant public action or reveal. After a draw, tutor, card return, hand replacement or new game, weaken or reset stale inferences as appropriate: a response unavailable earlier may be available now. Preserve public facts separately from guesses; never silently promote a hypothesis to knowledge.
5. Use the range to compare lines, not to chase certainty. Where strategically sound, lead with a lower-value threat, sequence two spells, or yield priority to learn whether the opponent commits. Consider the cost of the probe and the worst credible response; do not throw away material or consume the clock merely to obtain information. Update from the resulting public action, not from how long the opponent took.

For example: an opponent with suitable untapped mana lets a minor creature resolve. A counterspell remains plausible because saving it may be correct. If they later allow a much more consequential, legally counterable spell to resolve with the same resources, lower that hypothesis, but do not mark the counterspell impossible. After their next draw, reopen the possibility.

Keep this ledger in the agent's working context; the MCP does not automatically persist it. Summarize it compactly when replanning or resuming, using only information available from your seat. A range estimate never overrides legal engine choices or sequence interruption guards. If an opponent response, reveal or other new information interrupts a queued line, read the fresh state, update the ledger and replan only the unapplied remainder.

For a library deck, call `list_deck_archetypes({"format":"Pioneer"})` to get the selectable labels. Pass the matching `archetype` alongside `name`, `format`, and `deck` when calling `create_deck` or `update_deck`. For updates, use the saved deck's `revision` as `expectedRevision`. Its `listVersion` identifies the card composition across games and survives a rename or printing change.
