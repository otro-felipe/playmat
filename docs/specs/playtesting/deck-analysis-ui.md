# Private history and deck performance

A signed-in player sees all practice matches in History and can filter the match list by Magic format. Each format and own-archetype card shows match wins and the number of completed matches. Selecting a card opens a separate analysis page. The initial detail always shows the same aggregate as the card. Choosing a saved deck selects its current version, including lists with no recorded matches. If a family has since changed format or archetype, its historical group starts with all its versions in that group.

The player can select a deck and version, all versions of a deck, or the whole archetype. Navigation, reload and sharing a link within the same account preserve that selection. Bo1/Bo3 and opposing archetype further constrain the same data. In Bo3, the Overview prioritizes match win rate and provides game win rate, preboard/postboard and play/draw. Bo1 has a single win-rate headline. A zero sample displays a dash. Every rate identifies its sample.

Mulligan shows recorded final kept hands, the number of games with a hand available, results by mulligan count and win rates and sample sizes both with and without each card among verified kept hands. Matchups shows results by opposing archetype plus outcomes in games where the opponent publicly showed a given card. Where accessible, the card lists example replays from those games. Unclassified opponents and missing observations remain visible as such.

The static analysis is additive. The chronological match list still provides expandable game details, AI review, replays, pagination and game-level export. Errors fetching performance leave the chronological history usable.

Both the kept-hand card table and the publicly observed opposing card table offer the same accessible card preview as the replay. A card's preview and its example replay links are independent controls.


The catalog includes the 40 named Pioneer families in MTGTop8's aggro, control and combo categories and the narrower families published by MTG Decks and Magic Online. The three miscellaneous groups remain unclassified. A complete list can identify an archetype through an unambiguous combination of its main-deck cards, including when its title names a different strategy. A library with no main deck and no sideboard uses the descriptive label “Empty deck”. An archived game without a submitted deck has no inferred archetype.

History shows the matchup archetype for each seat after match completion. The archive uses its registered label, its opening game, an exact list owned by that seat or evidence in its submitted list. Human and MCP seats follow the same rules. The startup migration revisits inferred defaults across both libraries, including previous and retired revisions. Coverage counts classify explicit or evidenced labels and report missing labels and Other separately as pending. Historical reclassification preserves public deck IDs, revision numbers and list signatures.

A completed or interrupted match can be marked as unrepresentative by a signed-in participant who can see it in History, or by a service operator addressing its exact match ID. A reason is required. The first successful mark records the reason, author and time for both seats. Identical retries preserve this record and a different reason conflicts. Delegated play/history credentials cannot change eligibility. Historical completed matches default to included. Interrupted matches can carry a reason even though they already contribute zero games to statistics.

All completed games in an excluded match leave both players' statistical samples, including deck versions, archetypes, matchups, cards, splits and win-rate denominators. Both players can still see the original score, reason, replay, export and review in their retained history.

Opening `/history?matchId=<UUID>` shows that retained match expanded for its participant. On the deployed service, an operator can run `node /opt/playtesting/product/match-statistics-cli.mjs inspect <UUID>` to check eligibility and archive counts without opening any replay. To exclude that exact match, use `node /opt/playtesting/product/match-statistics-cli.mjs exclude <UUID> "Reason"`. This records `service-operator` as the author.
