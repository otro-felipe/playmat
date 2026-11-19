# Post-match replay and strategic review

Private Playmat participants can revisit a completed encounter, inspect the evidence available at the time of a decision, and read saved strategic annotations without changing the game or its result. Each replay position belongs to one immutable archived game and its event cursor.

## Permission and capture

- **PM-REVIEW-PRIV-1** An eligible private testing table records both hands for completed-match review as part of the table policy. Creating or joining the table does not require a separate consent setting.
- **PM-REVIEW-PRIV-2** During any game or inter-game sideboard, a new review endpoint cannot return private replay evidence, scopes for other seats, or review annotations. A completed game in an active best-of-three remains redacted in the legacy replay.
- **PM-REVIEW-PRIV-3** An eligible participant in a completed encounter opens the replay with both recorded hands when the archive supports it and can switch to recorded knowledge by seat at the same event cursor. A delegate with history access can act within the account's authorized history. An outsider or ordinary shared replay never gains access to hidden zones even with a valid game ID.
- **PM-REVIEW-PRIV-4** A pre-existing archived match shows both hands wherever the protected archive has both hands and the participant scope can be established. Missing ownership or missing archived data cannot be reconstructed.
- **PM-REVIEW-CAPTURE-1** For a protected private testing recording, an authoritative draw preserves the card drawn, actor, game order and phase even if the card leaves the hand between snapshots. An exile play, a look, a reveal, a return, and a search into hand remain different events. Legacy coverage identifies where draw identity is unavailable.
- **PM-REVIEW-CAPTURE-2** Capture and projection preserve the recorded mulligans, zones, stack, priority, spell and target evidence, combat and sideboard boundaries. An erased branch from rollback does not contribute candidate decisions or ratings. Protected capture data stays in the private raw archive. Existing live messages, legacy replays, shared links and exports keep their redaction.

- **PM-REVIEW-CAPTURE-3** At a protected opening decision, the completed replay records the deciding seat, keep or mulligan outcome, hand before it changes, and any committed card placement separately. A legacy keep may use the first post-keep hand when the log proves continuity before any subsequent change. Missing rejected hands remain unavailable.
- **PM-REVIEW-CAPTURE-4** A protected choice records the actual chooser, the affected seat, source, legal choices, and selection when recorded. A priority pass preserves material opportunities and whether the pass was manual or automatic when the engine can determine that. Opening hands and private options are available only in permitted post-match perspectives.

## Evidence and saved analysis

- **PM-REVIEW-API-1** An authenticated participant can read review capabilities for an authorized match or game and query page-sized evidence by cursor or turn. Cursors remain stable across projections. Evidence explicitly identifies the archive version, coverage and whether an action was directly recorded or reconstructed from an archive observation.
- **PM-REVIEW-API-2** Historical analysis uses the acting seat's pre-action knowledge where recorded. Personal cards looked at, prompt choices and opposing hidden cards require the corresponding evidence and authority. A separate retrospective explanation can describe what later occurred. A conclusion about a move cannot use unrevealed facts from that explanation.
- **PM-REVIEW-API-3** A history client can save and read partial annotations for exact eligible events, including the actual play, alternatives, evidence, benefit, risk, plausible responses, perspective and confidence. The same submission can be retried without changing counts. A stale edit or mismatched evidence version does not overwrite a saved annotation.
- **PM-REVIEW-API-4** Coverage and category totals derive from persisted annotations and can be grouped by game and acting seat. One event has at most one current annotation per allowed perspective. Trivial passes may be left unclassified. Partial and insufficient evidence remain distinct from an unreviewed game and from a confident strategic grade.
- **PM-REVIEW-API-5** Evidence and advice apply to the archived mode and format as recorded. External references may use public format, archetype, matchup and rules context with URL, date and relevance. Private cards, deck lists, game IDs and personal histories stay out of external queries.
- **PM-REVIEW-API-6** Once an encounter ends, its review can show the viewing seat which cards entered and left its main deck between two adjacent completed games with complete submitted lists from the same card pool. The comparison groups copies by card name and omits unchanged cards. It gives no information about another seat's lists, even when full-hand review is authorized. Missing or ambiguous snapshots leave the comparison unavailable. The resulting difference describes the lists used when each game started. It establishes no order or timing for the underlying sideboard changes.

- **PM-REVIEW-API-7** The requested MCP review workflow visits the recorded decisions for both acting seats and resumes from saved annotations. It saves a rationale and comparators per supported decision and indicates when the archive cannot support a strategic grade.

- **PM-REVIEW-API-8** The optional replay guide and native review prompt teach matchup research using prior games, own sideboard context, rules, and dated public sources. They distinguish observed cards, public archetype hypotheses, and later revelations. The four play guides remain a separate bootstrap bundle.
- **PM-REVIEW-API-9** Review may save a material inferred omission on an observed window when the acting seat, legal comparison, and later closing evidence are supported. Review labels the inference separately from a recorded choice. Routine passes remain outside grading where no decision mattered.
- **PM-REVIEW-API-10** A coarse snapshot can support a qualified grade when other archived observations and a credible comparator establish the material facts. Exceptional grades require an exact position. Existing annotations preserve their archive anchors and revisions when reviewed again.

## Strategic rubric

Evaluate from the position before the play. Identify the objective, relevant mana and timing, known cards and counters, exchanges and the credible opposing responses. Grade one decision at a time, including mulligans, sequencing, holding interaction, priority, combat and sideboard when supported by the evidence. Include the chosen move among alternatives. State when legality comes from an observed choice and when it follows from visible constraints and the rules. Moved cards and later information are evidence for the retrospective panel only.

The [review rubric](review-rubric.md) defines how to assess decisions. In replay, brilliant is blue with `!!`, ideal is dark green with a star, normal is light green with a check, inaccuracy is orange with `?`, and mistake is red with `??`. The interface groups the existing good, acceptable and equivalent ratings under normal. Insufficient evidence has a neutral treatment.


## Replay and history UI

- **PM-REVIEW-UI-1** From a replay link, a participant can step through decisions, select a rated decision marker in the playback bar below the board, and change perspective while keeping the exact cursor. Recorded stack entries, targets, and choices are visible at the associated replay position where evidence is available.
- **PM-REVIEW-UI-2** A legacy or incomplete replay explains which evidence is available. An account or authority change removes private data from the rendered replay. Protected responses are not reused in a shared view.
- **PM-REVIEW-UI-3** History shows analysis state, scope and persisted rating totals, expandable by player and game, with links to the recorded moment.
- **PM-REVIEW-UI-4** The review occupies a collapsible desktop side panel and an accessible mobile control. Opening or closing it keeps the current replay frame and the board available.
- **PM-REVIEW-UI-5** Each recorded strategic decision is navigable. The decision list and board show the saved rating with the same icon and color. Notes use a descriptive heading with linked card previews, then the rationale and alternatives. An unreviewed decision has a pending state. A decision with insufficient evidence is explicitly identified.

- **PM-REVIEW-UI-6** Left and Right navigate replay decisions or adjacent frames when decision metadata is unavailable. Shift with Left or Right moves by turn. Editing controls and active dialogs keep their key behavior. Notes show strategic confidence and identify recorded opening-hand context and inferred omissions when available.

Verify API and MCP permissions with both participants and an unrelated account, archived legacy data, an active best-of-three sideboard, and frozen complete replays. Verify a real engine record with committed draw and known cast events, plus desktop and mobile navigation to a persisted annotation.

## Executable evidence

- `ops/playtesting/product/product.test.mjs` covers automatic capture and historical access in PM-REVIEW-PRIV-1 through PM-REVIEW-PRIV-4 and the persisted review API boundaries.
- The PM-REVIEW-API-6 tests in `ops/playtesting/product/product.test.mjs` verify adjacent submitted-list differences for both seats, opponent hand visibility, incomplete lists and the inter-game boundary.
- `ops/playtesting/product/replay-capture.local.mjs` and `replay-review.local.mjs` exercise native Java capture and authenticated native MCP for owned, alternate and full views. The script archives the actual recorded game into an isolated store and checks a committed draw, cast, target, payment, and annotation retry.
- The `[PM-REVIEW-API-8]` test in `ops/playtesting/mcp/test/acceptance.test.mjs` verifies matchup guidance in the native prompt. The guide resource is checked against the tools-only interface and four-game-guide bootstrap.
- `ops/playtesting/product/review-presentation.test.mjs` covers PM-REVIEW-CAPTURE-2 with a witnessed stack, recorded modes and targets, and legacy spell and discard references.
- `Mage.Server/src/test/java/mage/server/replay/ReplayStoreTest.java` verifies protected replay fields stay out of legacy projections.
- `Mage.Web.Client/e2e/private-replay-review.spec.ts` verifies desktop and mobile acceptance with authorized synthetic fixtures. `ReplayReview.test.tsx` and `HistoryReview.test.tsx` exercise stable cursors, authority transitions and counts.
