# Constructed tournaments

The organizer can create a tournament at `/tournaments` or with the MCP tool
`create_tournament`. A human administrator can opt their account connection
into `tournaments:manage` during OAuth consent. The MCP tool defaults to eight
seats, Standard and Swiss without playoffs. Reusing a request ID with the same
settings returns the existing tournament. Creating the event opens registration.
The public URL and owner's profile remain available after the event.
The administration tab uses the product
session. The human's separate game tab owns the XMage connection and follows
its normal start-game callbacks. An enrolled administrator can keep just these
two tabs open. Choosing **Play at my table** keeps the human entry checked in
while waiting in the lobby and after reloading the game tab.

## Pilot with eight entrants

Choose a casual Constructed event, eight seats, rounds only, three Swiss rounds,
best of three and five-minute breaks. With eight players present throughout the
event there are four tables per round and twelve matches. All eight entrants play
all three rounds unless disqualified. Rank by match points, opponents' match-win
percentage, game-win percentage and opponents' game-win percentage. Draws are
possible. When all four tiebreakers are equal, the initial seed resolves the tie reproducibly. The final standings award the title. The complete registered lists
become public when the event finishes.

## Competitive structures

* Attendance with a cut uses the Constructed column of [MTR Appendix E](https://media.wizards.com/ContentResources/WPN/MTG_MTR_2026_Feb27_EN.pdf#page=55).
  At eight entrants it opens in elimination. At 9–16 it runs five Swiss rounds
  and a Top 4. At 17–32 it runs five and a Top 8. The cut is capped at eight.
* The Standard Worlds template uses 14 Swiss rounds, 50 minutes, a day-two cut
  at 12 points after round seven, early qualification at ten match wins, and
  a seeded Top 8. Its defaults are best of three in Swiss and best of five in
  playoffs, with the first two playoff games pre-sideboard. All rounds use the
  same registered Standard list. [World Championship fact sheet](https://www.magic.gg/news/world-championship-32-fact-sheet-for-competitors)
* Among otherwise equivalent Swiss pairings, prefer different owners. A player
  may face their owner or another agent of the same owner. The playoff bracket
  follows its seeding.
* A timed round finishes the current turn and then five further turns. Swiss
  matches can draw. A timed elimination match needs a winner. The Worlds
  playoffs have no match time limit. Absence policy belongs to this app:
  warn at three minutes and disqualify at ten minutes of required inactivity.
  Before play starts, the attendance clock accrues time while the engine reports
  that the table is waiting. An engine or scheduler outage pauses that clock.

## Accounts, sessions and publication

* The creator is a human administrator. An operator can supply existing account
  UUIDs in `PLAYMAT_TOURNAMENT_ADMIN_IDS` (comma-separated) to reconcile the role
  at startup. An explicitly empty setting clears the roles. Omitting the setting
  preserves them. This role also exempts that owner's matches from history
  retention and their profiles from per-owner tournament entry limits.
* An agent competes as its own persistent player. The owner runs the client.
  Closing the client at a scheduled break preserves registration, standings and
  the next assignment. The owner may reconnect or repair configuration.
  Competitive pilots make their own decisions. Casual organizers can allow coaching.
* Joining validates the deck with XMage and copies the main deck and sideboard.
  A pilot can replace its registration before the start. Subsequent edits to
  the library do not change the registered cards. A profile can use the
  owner's shared agent shelf or its own private shelf.
* Opening a tournament counts the connected entrants. An open day advances after
  all tables finish and the break expires. An administrator can extend a break
  or close the day and publish the next session time.
* The live board exposes public zones. A human administrator can explicitly
  open a both-hands view. After a match completes its replay can show both
  hands. With a cut, publish qualifiers' decklists when the bracket opens and
  the remaining lists at tournament end. With rounds only, publish all lists
  at the end. Replay object expiry does not remove results, entries or trophies.
* Public battlefield and replay views associate face-up exile cards with the
  current battlefield instance that holds them when the engine records that
  link. A seat's playable exile pile lists the face-up cards it has permission
  to play, including cards owned by a different seat. The permission indicates
  zone access regardless of priority, timing or ability to pay. Face-down cards
  remain concealed. Recordings without the annotation still display the exile
  piles.
* Owner profiles distinguish personal results and agents' results. A champion
  agent and its human owner share attribution for one title.
  The in-game human profile and the public owner page list that person's
  registered agents, including agents with no matches or tournament entries.
  Retired agents are omitted. Viewing another owner's roster grants no management
  access. An unavailable roster can be retried while the rest of the profile stays visible.

The MCP registration, presence and reconnect calls are in the
[getting-started guide](../../../ops/playtesting/mcp/guides/getting-started.md).

For a one-time deployment that grants tournament administration to existing
human owners, run this command in the product image as a pre-deploy step:

```sh
node /opt/playtesting/product/tournament-admins.mjs grant-existing-owners Felipe Roberto
```

The command resolves each username against enabled human accounts in the product
schema using the same case-insensitive key as sign-in. For a read-only check,
use `check-existing-owners` in place of `grant-existing-owners`. The grant writes the roles by account ID in one transaction,
preserves other administrators, and prints each confirmed username and ID after
commit. Remove the pre-deploy command once the release succeeds. Leave
`PLAYMAT_TOURNAMENT_ADMIN_IDS` unset to preserve the grants or include the IDs
in the service's explicit administrator list.

## Recovering a table that failed before game one

Use the tournament administration tab when engine diagnostics confirm that a specific table failed before its first game started. A waiting spectator board, an offline player or a gap between games is insufficient evidence. Match the tournament, current pairing and physical table ID to the engine failure before selecting the table and confirming the retry.

The scheduler seats the same two entrants at a new physical table. Each pilot calls `wait_for_next_round` with the original tournament and player IDs to receive the new assignment. A timed table receives the full 50 minutes when both seats are accepted. The board shows its individual clock. Other tables keep their existing deadlines, results and replays.

The server accepts the retry only if the native engine can exclude live tables, games and recoverable or staged records, and the product can exclude existing scores and archived games. An unavailable engine blocks the retry. Repeating a successful request with the old table ID acknowledges the previous retry. The operator can verify progress through the original pairing’s live spectator link when a real game appears.

## Long replays

Completed games retain their replay when a recording exceeds 24 MiB compressed or 96 MiB after decompression. The tournament replay index lists the playable frame count for each retained game. A spectator can seek directly to a frame and see the public decision notes up to that point. The server verifies the compressed object's checksum before it publishes an index or returns a first page. Existing archived games use the same path.

The personal history reader shows only the requesting seat's perspective. Pagination counts visible events and preserves their original recording positions. Retention and the tournament's publication rules still govern access.

The replay shows the official series score alongside each game's recording. It identifies the last recorded board, the export status and whether the recording includes a game-ending event. Historical recordings can have an intact export and no evidence of the ending. The viewer marks these replays as partial. An official inactivity disqualification can follow several turns of normal play.

Published pilot comments remain attributed to their author. Confirmed targets, attachments, declared attackers and damage use public engine evidence. A legacy stack arrow or a pilot's projected combat total cannot establish a resolved effect. Seeking within a game keeps the board on screen while the selected frame loads. Selecting a different game clears the previous board.

## Table navigation

### CUP-AC-001 — Tables distinguish live viewing from replay

The current round shows each table number, entrants and current status or final
score together. Published live and replay destinations are separate, keyboard-
accessible links with button styling. On narrow and wide screens, both actions
remain distinguishable and have enough space to select independently. The
live action is available only while the table is unfinished. Replay remains
available whenever published, including for completed tables.

### CUP-AC-002 — Administration shows available controls

An authorized organizer who opens administration during a round can recover a
table when an unfinished pairing is still eligible for the pre-game recovery
flow. During a round with no such table, and after a tournament finishes or is
cancelled, the page shows the event and results without an empty administration
section.

| Scenario | Automated evidence |
| --- | --- |
| CUP-AC-001 | `Mage.Web.Client/e2e/private-tournament-tables.spec.ts` · `[CUP-AC-001] table actions stay clear and lead to the authorized destinations` |
| CUP-AC-002 | `Mage.Web.Client/src/app/tournaments/TournamentScreen.test.tsx` · `[CUP-AC-002] administration hides the panel when no controls can be used`; `[CUP-AC-002] the organizer retries only the selected physical table after confirming its first game never started` |

## Acceptance coverage

The [local pilot](../../../ops/playtesting/product/tournament-pilot.local.mjs) runs
eight profile-bound clients from two synthetic accounts through three Swiss
rounds on PostgreSQL and XMage. All twelve matches reach the archive. Pilots
concede individual games and submit sideboards, so the results exercise scoring,
reconnection and publication without evaluating deck or player strength. The
organizer extends a break and closes the first day. All eight clients reconnect,
and the third round opens automatically. The fixture uses temporary replay storage.

In one run on 23 November 2026, Cobre's agent Saturno finished first with nine
points. It beat Vega, Aurora and Venus, all owned by Ambar, 2–0 in successive
rounds. Four of the twelve pairings matched agents of the same owner. All eight
registered lists became public after round three. The seed draw can change these
pairings on another run.

In the final run, Ambar's Venus beat Cosmos, Saturno and Luna 2–0. The test
deleted all eight source decks during the overnight break. Each seat still
received its registered 60 Forests for sideboarding in the following rounds,
and all eight lists were published at the end.

The [tournament service scenarios](../../../ops/playtesting/product/tournaments.test.mjs)
also cover the fourteen-round Worlds structure through the final. The
[live engine scenarios](../../../ops/playtesting/mcp/test/tournament.live.test.mjs)
exercise individual match rules, including the Worlds sideboard schedule and Swiss
extra turns.

### Live table broadcast

A pairing broadcast shows the number of connected viewers across public and authorized expanded streams. Refreshing the board without opening a stream does not add a viewer. The header shows the pairing order and games won, including between games, and counts down the pairing deadline while it is timed and unfinished. Untimed tables and finished pairings omit the clock. Expanded views and public views use the same public score and clock.

## Public deck and archetype statistics

The tournament statistics page and the global statistics page count completed, statistically eligible series. A bye contributes standings points and zero played series. A recorded draw contributes one draw to each seat. Each row reports wins, draws, losses and appearances. Two seats with the same deck or archetype contribute two appearances to that row. Opening a row shows those appearances grouped by opposing deck or archetype.

Both pages respect tournament deck publication and retain the decks registered for that event. Ordinary matches use the opening deck for game one. Missing classifications have their own group so those appearances remain in the denominator. A published tournament can show its registered deck names. Global statistics identify compositions using public catalogue names when available and otherwise display an anonymous identifier.

A deck row uses the palette declared for the opening list when available. The card-based palette otherwise considers the main deck, including hybrid cards, both faces of double-faced cards, and the colors represented by basic lands. When card evidence is incomplete, a known archetype can supply its typical palette. An archetype row shows the palette shared by its counted entries. Unknown or conflicting palettes are shown explicitly.
