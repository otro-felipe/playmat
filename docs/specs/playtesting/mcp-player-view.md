# MCP player view

### PM-VIEW-01 — Equivalent gameplay choices

The MCP gameplay tools `get_game_state`, `play_line` and `wait_for_decision` accept `view: "compact"`. The response retains the game, epoch, cursor, timing, legal choices and all state needed to make a play, including rules, costs, ability text, targets, damage, and combat assignments. Execution status, progress and interruption signals remain available. Omitting `view` returns the existing full contract. Changing only the response view on a retained command does not replay an action.

### PM-VIEW-02 — References within one snapshot

A choice can carry `cardRef` in compact mode when its card matches a single visible card record in the same state by object ID and gameplay fields. Repeated identical records in the battlefield and combat describe one object. Conflicting records, cards without usable IDs and cards visible only in the prompt stay inline. Pile membership and current prompt text stay available. Compact cards omit empty hint lists and printing metadata. Live hints with content remain available because they can describe restrictions and other active effects.

### PM-VIEW-03 — Resume a line

A command wait uses the game and command IDs returned for the same line. Missing game IDs and cursor or decision filters produce `invalid_line_wait`. Ordinary waits can filter by the last observed cursor or decision. A compact timeout uses `state.cursor`, and a compact interruption retains any pending rollback vote and the current prompt. A compact error with current state exposes the same gameplay information as a compact success.

### PM-VIEW-04 — Recover from an ambiguous selector

When several options share a label, an ambiguous selector leaves the prompt open and tells the caller to use the current `decisionId` and exact `choiceId`. The option text or card detail remains available to distinguish the choices.

The HTTP tests in `ops/playtesting/mcp/test/player-view.test.mjs` cover these scenarios.

| Requirement | Test |
| --- | --- |
| PM-VIEW-01 | `compact state, line and wait carry the same actionable combat and target choices` |
| PM-VIEW-02 | `compact choices keep inline cards when a visible reference would lose information` |
| PM-VIEW-03 | `compact wait keeps rollback state and rejects incompatible command filters` |
| PM-VIEW-03 | `timeout and stale-line recovery keep the current cursor in compact state` |
| PM-VIEW-04 | `an ambiguous ability label can be recovered with the observed choice ID` |

The isolated XMage fixture in `ops/playtesting/product/sequence.local.mjs` checks paired UTF-8 MCP text lengths and equivalent prompts from actual engine callbacks. The fixture emits numeric sizes and its named scenarios.

### PM-PLAYER-01 — Interleaved seat selection on one OAuth connection

A canonical OAuth connection with play authority can discover the account’s enabled MCP profiles using `list_players` and select one by outer `playerId` on each seat operation. All authorization, leases, engine identity, private views, decisions, idempotency keys and command receipts are specific to the selected profile. Two profiles can play opposite seats of a single game; four can play two simultaneous games through the same credential. Concurrent calls cannot change another call’s selector. A disabled or foreign profile is unavailable. Disabling a profile ends its authority while other allowed profiles remain accessible. Revoking the connection ends its access to every profile.

When the canonical connection can select profiles, an unselected new seat request fails with `player_required`. A verified, already attached legacy game may continue with the same grant and explicit game ID. A profile-bound OAuth connection stays restricted to that profile, including when no selector is supplied. Original Human Player operations still require their own table-specific consent. The browser retains ownership of its tables.

The native guide contract in `ops/playtesting/mcp/test/acceptance.test.mjs` executes the SDK selector from the startup bundle. The `player-identities` family in `ops/playtesting/product/player-identities.local.mjs` exercises one client, one canonical OAuth bearer, four private opening hands, opposite-seat receipts sharing a command ID, two live tables, owner-only human control and revocation with PostgreSQL and XMage.

## Local verification on 2026-11-18

The Node 22 Docker build succeeded. The MCP suite passed 258 tests, skipped 3 opt-in live tests and had zero failures. The isolated real-engine acceptance ran separately with synthetic seats, fresh PostgreSQL and the candidate MCP files over the local Playmat engine image.

| Same XMage position | Full MCP text (UTF-8 bytes) | Compact MCP text (UTF-8 bytes) |
| --- | ---: | ---: |
| Priority with spell and mana choices | 13,997 | 9,857 |
| Retained `play_line` at the target prompt | 9,834 | 8,823 |
| Command wait at the same target prompt | 9,834 | 8,823 |
| Ordinary target wait | 9,084 | 8,073 |
| Ordinary mana payment wait | 13,552 | 9,712 |

The live fixture matched the cursor, decision ID, priority and legal options across both views. It used the compact priority receipt for the real cast and the compact waits for its target and payment. Synthetic HTTP fixtures also cover combat, rollback, a repeated label, and recovery errors. The measurements record text sizes from the local MCP transport. They do not measure the archived Pioneer replay or changes in model latency.

An explicitly consented canonical account connection can create persistent MCP players with `create_player_slot`. The same creation request UUID and normalized fields produce one slot across concurrent retries. A changed request body conflicts. A fixed profile, manual grant, and an existing play-only connection cannot create slots. Owner-approved players are listed only inside that account. A reservation acquired before an engine table exists counts as reserved and is excluded from `availableOnly`. A bound reservation counts as occupied.

The web host’s **Rival MCP** form defaults to the enabled players of the host’s own account. **Allow external players** broadens eligibility to an MCP player on another account holding the complete invitation link. The first eligible claim takes the only rival seat. Through the API, both a human and an MCP host can name an external player by its voluntarily supplied UUID. Only that exact enabled guest can claim it. A host can alternatively address a recipient account. Its canonical owner connection may assign one enabled profile through the ordinary join call. Competing profiles cannot both claim; the losing reservation is released without disturbing the winner. A browser friend invitation, the original MCP rival on an account without enabled profiles and previously supported guest engine names retain their authorization. Account assignment never grants its host access to another account’s slots, decks, hands or spectator link.

### PM-SPECTATE-SEATS — Share both seats during one MCP match

A trusted MCP host chooses `spectatorVisibility` when creating a table. Omission and `public-board` issue the ordinary public link. Choosing `both-hands` preserves that link and adds an independent live-only capability. Only the web host can retrieve the latter; bearer tools and other owners cannot discover it. The guest sees the mode in its invitation. A guest belonging to a different account must explicitly send `acceptSpectatorVisibility:"both-hands"` to claim. Retrying creation cannot change visibility.

GET and SSE enforce the same game, roster and entitlement on every connection. The additional link shares current hands, cards already shown through look/reveal effects, and a top card only when XMage showed it to that seat. No library order, hidden faces, decision internals, private conversation or archival replay is included. Each pilot still receives its own perspective. A waiting or sideboarding link has no hand data. The expanded feed includes complete ordinary TALK from the two players in this game. On completion or interruption it closes with the public link for that exact table. PG/API coverage is in `oauth.test.mjs`; the Docker XMage family is `spectator-visibility`.


The browser host can PATCH an eligible waiting MCP table's `spectator-link` with `{"spectatorVisibility":"both-hands"}` or `{"spectatorVisibility":"public-board"}`. Owned table listings advertise `canConfigureSpectatorVisibility:true` while they allow this action. Disabling the expanded link immediately revokes it, including open streams. Re-enabling it creates a different private link and keeps the public link stable. The first guest reservation or claim locks the mode permanently, including after an abandoned join. Started matches cannot change. A join from a stale inspection must recheck the invitation before entering.
