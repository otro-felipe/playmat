# Readable match actions

## Purpose and scope
Keep public targets and fast sequences readable without delaying authoritative game state or manual input.

### Requirement: READ-REQ-001 — Public stack targets
Every stack item SHALL identify its announced targets while it waits on the stack. Names SHALL come only from public zones in the current view. Hidden or unavailable objects SHALL use a generic label, including face-down objects.

#### Scenario: READ-AC-001 — Announced targets before resolution
A spell or ability waiting on the stack names its player, permanent, graveyard or stack targets. Multiple targets receive separate labels. A hidden hand card never supplies a target name.

### Requirement: READ-REQ-002 — Continuous game log
The log SHALL retain its existing bounded history while receiving subsequent turns and resolutions. Reauthentication SHALL rejoin game chat. Message identities SHALL remain unique across rejoining. A full buffer SHALL continue scrolling to newly received lines.

#### Scenario: READ-AC-002 — Log continuity
After turn 3, a chat reconnect, and stack resolution, subsequent public lines appear alongside retained earlier lines. At the history cap, a new line still moves the viewport to the newest entry.

### Requirement: READ-REQ-003 — Readable presentation without stale controls
Public plays SHALL receive a short, ordered presentation independent of the authoritative board. A bounded backlog SHALL explicitly count overflow rather than silently imply all actions were presented. Historical cues SHALL be labelled as recent actions and SHALL not accept game actions. Auto-pass SHALL leave time to read a nonempty stack; manual controls and priority clocks SHALL remain immediate. Reconnect, rollback and game end SHALL discard obsolete presentation and automated answers.

#### Scenario: READ-AC-003 — Fast sequence
Several updates in one render interval are captured in order. A spell's target announcement and resolution remain readable after the live board advances. Overflow is counted. A new decision uses the current board and prompt immediately.

## Traceability
| Scenario | Regression cases (execution pending) | Remaining checks |
| --- | --- | --- |
| READ-AC-001 | `Mage.Web.Client/src/core/game/publicTargets.test.ts` — `labels players, permanents, graveyards and other spells before they resolve`; `never names private, face-down, hidden or missing objects`. `Mage.Web.Client/src/app/match/StackZone.test.tsx` — `keeps public targets visible for every waiting spell and ability, with no hover or resolution` | Mobile browser rendering |
| READ-AC-002 | `Mage.Web.Client/src/app/match/GameLog.test.tsx` — `[READ-AC-002] receives turns and resolutions after reconnect, including lines delivered during chatJoin`; `[READ-AC-002] a full log still scrolls to new actions after the bounded buffer stops growing`; `[READ-AC-002] retries an initially refused chat join and receives subsequent actions`; `[READ-AC-002] an old join resolving late cannot leave the newer membership` | Real disconnected mobile transport |
| READ-AC-003 | `Mage.Web.Client/src/core/game/actionPresentation.test.ts` — `captures cast, targets and stack departure across unrendered updates without delaying the real state`; `bounds a burst and accounts for every omitted preview, then drains and resumes`; `discards obsolete receipts on %s and never replays the reconnect snapshot`; `shows battlefield entries and hides the identity of a face-down play`. `Mage.Web.Client/src/app/match/RecentActions.test.tsx` — `presents rapid public actions in order as read-only history while the real stack has advanced`. `Mage.Web.Client/src/app/match/useAutoPass.test.tsx` — `leaves a complete reading beat for a targeted stack object even while passing the turn`; `manual priority responses are immediate during the presentation beat`; `does not answer a newer prompt arriving before React cleans up the old timer`; `rejects the old automated answer after %s`; `rechecks the live settings before executing a previously scheduled automated answer` | Live multiplayer cadence |

## Known limitations
The server does not replay game-chat history on rejoin, so lines broadcast while disconnected cannot be reconstructed by this client change. The reported turn-3 session has no transport trace; regressions reproduce concrete client failure modes, not the exact original connection.
