# Post-match review rubric

Review a recorded decision from what the acting seat could see at the time. Compare the played line to plausible legal alternatives across a shared horizon such as the end of the current combat or the first priority decision after the stack resolves. Check timing, sources and costs, targets, the sideboard used for the current game and the number of remaining actions needed to realize a benefit. For each line, describe the most credible replies that could change the comparison. Separate facts in the recorded position from matchup hypotheses. A response learned later belongs in the optional retrospective field and is excluded from this comparison.

## Ratings

| Assessment sent by the agent | Rating shown | Decision criterion |
| --- | --- | --- |
| `exceptional` | Brilliant | A hard-to-find line is the only verified line that yields a material advantage. Credible alternatives leave the acting player worse off. The archive identifies an exact preceding position and the analysis includes a confirmed comparator, a credible reply and high confidence. |
| `optimal` | Ideal | The play gains material value in the shared horizon and no confirmed legal comparator improves the result. The review documents at least one confirmed comparator. |
| `sound` | Normal | The recorded line supports an identified goal and handles the credible responses, with no established material drawback. |
| `acceptable` | Normal | The recorded line is reasonable though the position or response range does not favor it strongly. |
| `small_loss` | Inaccuracy | A confirmed legal alternative improves a meaningful resource, timing or threat while preserving the plan. |
| `decisive_loss` | Mistake | A confirmed legal alternative avoids a material loss over the chosen horizon. Explain the decisive difference. |
| `equivalent` | Normal | At least two confirmed legal lines have no meaningful difference under the stated responses. |
| `insufficient` | Insufficient evidence | Timing, legality or a material fact could not be established. |
| `trivial` | Unrated pass | Passing at that ordinary decision needs no strategic rating. |

Use `confirmed` for an alternative supported by the recorded timing, rules and payment. Use `conditional` when a named condition changes legality or outcome. Use `unverified` for a hypothesis with insufficient evidence. A lower-confidence question can be recorded without treating the alternative as certain. A preceding or coalesced snapshot caps reconstructed strategic confidence at medium. Using a coalesced frame requires evidence that establishes the material position and a confirmed legal comparator. Low confidence identifies what remains unknown and prevents a definitive grade where the missing fact could change the comparison. A saved note increments a category count only once, even when a request is retried. Analysis completeness refers to recorded candidates and remains separate from archive coverage.

For a hand-disruption decision such as Thoughtseize versus keeping mana for Fatal Push, use the acting hand, available mana, turn, observed colors and public plays. Explain which line better covers likely early threats in that matchup and when either line gives the opponent a useful opening. If the reply only follows from public archetype data, mark it plausible. A card verified in a later replay frame can explain the actual outcome in the retrospective field of an authorized complete replay.

## MCP review workflow

1. Use `get_match_review` with a game or match ID to read the available evidence and visible analysis coverage.
2. Use `read_review_evidence` with `purpose:"analysis"` and the acting seat. Use the returned raw archive cursor and immutable revision across requests. For each acting seat, follow `next` through all recorded strategic decisions. `purpose:"replay"` reads the timeline from an authorized perspective. Available full replay and the analysis snapshot serve distinct purposes.
3. Read the [replay analysis guide](../../../ops/playtesting/mcp/guides/replay-analysis.md) and use `get_card` for printed text. Use public plays from earlier games and the acting seat’s own sideboard as historical context. Use `get_guide` for the rules. `list_archetypes` and `find_possible_responses` give public hypotheses for the competitive formats they cover. Consult sources for the recorded format where needed. A saved source contains a public HTTPS URL, date, format and an explanation of applicability. The backend stores the reference without requesting the URL. Send only public generic rules or matchup queries to external sources.
4. Read existing notes with `list_review_annotations` and review every remaining strategic decision and save small batches with `save_review_annotations`. Each entry targets the exact replay event and actor. Send the archive revision. When updating an entry, include its current annotation revision. Reuse the same request after an uncertain receipt and confirm the saved entry before deciding. Fetch the manifest again to check counts.
