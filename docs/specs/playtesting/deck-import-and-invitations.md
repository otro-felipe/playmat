# Deck import and human match invitations

## PM-SETUP-01 — Save imported decks without starting a game

### PM-SETUP-AC-01

Given a deck ready to import, saving it adds it to the deck library and selects it. The player remains outside a match and can start one with a separate play action. Editing or updating an existing deck stays within the deck workflow.

## PM-SETUP-02 — Choose a friend or share an unlisted match

### PM-SETUP-AC-02

The human opponent form offers the player's saved friends. Choosing one reserves the second seat for that account. The host can copy a link and starts the match after the invited player joins with a legal deck.

### PM-SETUP-AC-04

In private Playmat, the browser keeps separate friend and ignore lists for each signed-in account and server. Signing out hides those lists. Signing back in with the same account restores them. An older browser-wide list can be associated once with the previous trusted sign-in recorded in that browser. A browser with no such record retains the older data outside the account lists.

### PM-SETUP-AC-03

With no friend selected, Playmat creates an unlisted match. Waiting matches stay out of other players' table and invitation lists. A signed-in human with the link can view the table and request its single guest seat. The first successful claim reserves that seat for the claimant. The claimant can retry while the link remains valid. A different account cannot claim the seat or enter the game. MCP seats retain their existing authorization.

## Traceability

| Scenario | Executable evidence |
| --- | --- |
| PM-SETUP-AC-01 | `Mage.Web.Client/e2e/deck-import.spec.ts`, `[PM-SETUP-AC-01] a pasted list can be fixed and saved before explicitly playing`; `Mage.Web.Client/e2e/app-private-bo3.spec.ts`, `[PM-SETUP-AC-01, PM-SETUP-AC-03] a saved deck stays in the library and an unlisted match opens only by link` |
| PM-SETUP-AC-02 | `Mage.Web.Client/src/app/screens/TablesScreen.test.tsx`, `[PM-SETUP-AC-02] the host selects a saved friend for the invitation` |
| PM-SETUP-AC-03 | `Mage.Web.Client/src/app/screens/TablesScreen.test.tsx`, `[PM-SETUP-AC-03] the host can create a link-only invitation with an empty friends list`; `Mage.Web.Client/src/app/screens/JoinScreen.webmcp.test.tsx`, `[PM-SETUP-AC-03] an unlisted table opens from its link while absent from the lobby`; `ops/playtesting/product/product.test.mjs`, `[PM-SETUP-AC-03] an unlisted link is undiscoverable and reserves a single human guest seat`; `Mage.Web.Client/e2e/app-private-bo3.spec.ts`, `[PM-SETUP-AC-01, PM-SETUP-AC-03] a saved deck stays in the library and an unlisted match opens only by link` |
| PM-SETUP-AC-04 | `Mage.Web.Client/src/app/stores/social.test.ts`, `[PM-SETUP-AC-04] private lists follow the authenticated account and server`, `[PM-SETUP-AC-04] only the recorded private login inherits the old list`, `[PM-SETUP-AC-04] an old list with no recorded owner stays outside all accounts` |

## Library archetypes and list versions

Each saved library deck has a predefined archetype for its format. The browser and MCP share the same choices. A legacy list gets a label from its existing name or recognizable signature cards, with Other for unidentified brews. An explicitly invalid label is rejected. Changing the label or display metadata preserves the list version.

Each deck has immutable edit revisions for concurrent saves and a distinct performance version for each composition. Counts in the main deck and sideboard define composition. Reordered entries, alternate printings, split duplicates and renamed decks retain their performance version. Restoring a previous composition restores its original version. The deployment migration reconstructs these versions in save order and preserves archived revisions.


An old inferred Other can be refined by an exact composition from the shipped examples, a complete basic-land practice list, or a starter title corroborated by its face card and format. Archived revisions with an explicit or unverifiable origin keep their label. Refinement preserves the deck ID, optimistic revision and performance version. Startup reports only counts. Among remaining Other decks, an empty list has no registered cards, an incomplete list has fewer than 40 main-deck cards, and the rest divide into lists containing exclusively basic lands in both zones and other lists with at least 40 main-deck cards. This last threshold describes the available data and does not assert format legality.
