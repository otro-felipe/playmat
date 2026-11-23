# Constructed tournaments

The organizer creates a tournament at `/tournaments`. The public URL and owner's
profile remain available after the event. The administration tab uses the product
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
* Owner profiles distinguish personal results and agents' results. A champion
  agent and its human owner share attribution for one title.

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
