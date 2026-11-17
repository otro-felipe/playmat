# Cards and matchups

Use `get_card` for a known `name` and optional `setCode`, `cardNumber`, or `format`. Read the card's rules text, costs, types, and printing. Check every relevant face before relying on a card's characteristics.

Use `search_cards` when you know features instead of a name. This example finds Pioneer blue instants with mana value at most two and a recognized keyword:

```json
{"format":"Pioneer","colors":["U"],"maxManaValue":2,"types":["INSTANT"],"keywords":["Surveil"]}
```

`colors` matches any requested color; `manaSymbols` and `keywords` each require every requested term. Use `nextOffset` if another source page is available. Keywords are a guide to the catalog's text, so inspect the actual cards for timing, additional or alternative costs, and target restrictions. A card's color and mana value need not equal the mana required to cast it.

Use `list_archetypes` for dated public examples. With a suspected archetype and available mana, use `find_possible_responses` with `format`, `archetype`, and relevant search filters. Check the provenance and `inPublicSample` flag, then decide which possibilities matter now. For example, look for instant-speed interaction, but also check relevant activated abilities on public permanents and the possibility of reduced or alternate costs. The result tells you what might be played. It has no access to the opposing player's hand or deck.

For your own deck, use `validate_deck` where authorized to check the whole list against XMage. For dated format policies and bans beyond the pinned engine's catalog, consult [Wizards' banned and restricted list](https://magic.wizards.com/en/banned-restricted-list).
