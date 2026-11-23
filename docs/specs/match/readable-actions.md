# Readable match actions

## Purpose and scope
Keep public targets and fast sequences readable without delaying authoritative game state or manual input.

### Requirement: READ-REQ-001 — Public stack targets
Every stack item SHALL identify its announced targets with board connections and accessible names while it waits on the stack. Names SHALL come only from public zones in the current view. Hidden or unavailable objects SHALL use a generic label, including face-down objects. No target text panel SHALL be displayed.

#### Scenario: READ-AC-001 — Announced targets before resolution
A spell or ability waiting on the stack names its player, permanent, graveyard or stack targets in its accessible label. Multiple targets receive separate labels. A hidden hand card never supplies a target name.

#### Scenario: READ-AC-004 — Targets connected across the entire stack
All stack objects with public targets SHALL draw persistent connections, including objects below the top card. There SHALL be no visible target text panel. The top object uses a stronger solid line; waiting objects use lighter dashed lines. Hovering or keyboard-focusing an object emphasizes its connections without hiding the others. Simultaneous connections to the same target SHALL follow separate curves. Public target names remain in each stack item's accessible label. Neither a private hand nor a private viewer can supply a connection endpoint.

### Requirement: READ-REQ-002 — Continuous game log
The log SHALL retain its existing bounded history while receiving subsequent turns and resolutions. Reauthentication SHALL rejoin game chat. Message identities SHALL remain unique across rejoining. A full buffer SHALL continue scrolling to newly received lines.

#### Scenario: READ-AC-002 — Log continuity
After turn 3, a chat reconnect, and stack resolution, subsequent public lines appear alongside retained earlier lines. At the history cap, a new line still moves the viewport to the newest entry.

### Requirement: READ-REQ-003 — Readable presentation without stale controls
Public plays SHALL receive a short, ordered presentation independent of the authoritative board. A bounded backlog SHALL explicitly count overflow rather than silently imply all actions were presented. Historical cues SHALL be labelled as recent actions and SHALL not accept game actions. Auto-pass SHALL leave time to read a nonempty stack; manual controls and priority clocks SHALL remain immediate. Reconnect, rollback and game end SHALL discard obsolete presentation and automated answers.

#### Scenario: READ-AC-003 — Fast sequence
Several updates in one render interval are captured in order. A spell's target announcement and resolution remain readable after the live board advances. Overflow is counted. A new decision uses the current board and prompt immediately.

### Requirement: READ-REQ-004 — Readable card choices and hand knowledge
The chooser SHALL show the hand cards provided for the active choice, with unavailable cards dimmed and disabled. The applicable choice payload determines which cards the viewer can see and select. Graveyard choices SHALL identify their players, including when a prompt spans multiple graveyards. The player's hand SHALL visibly mark its cards revealed from hand while they remain there.

#### Scenario: READ-AC-005 — Revealed hand with a restricted choice
After a hand is revealed for a nonland discard, both the land and nonland are present when the chooser opens. The land cannot be selected. Other hidden cards never enter the chooser.

#### Scenario: READ-AC-006 — Choices across two graveyards
Cards from each graveyard appear under the owning seat's name, including when the engine provides only target IDs.

#### Scenario: READ-AC-007 — Revealed hand marker follows the current hand
A public reveal marks the card even after the reveal panel expires. If the card leaves and later returns to the hand, a fresh reveal is required before the mark appears again. At a turn rollback, each seat recovers only the hand knowledge it held when that turn started. Later looks and reveals disappear and may appear again if their effect repeats. A fresh XMage seat view, including after reconnect or resuming a saved game, restores the public hand markers still supported by that checkpoint and only that seat’s own pending looks. An explicitly revealed library selection is marked when that same physical card moves directly into hand. A private choice or ordinary draw supplies no mark. An unidentified departure to a hidden zone clears all ambiguous markers in that hand, even when a replacement draw leaves the count unchanged. On an older server without these markers, the client uses only evidence received on the restored timeline.

#### Scenario: READ-AC-008 — Announced Room door
When a Room half is cast, the live stack SHALL name the public spell face. The combined Room card can supply the artwork and context. A door that opens on entry or through the unlock special action SHALL be identified in recent actions from its public battlefield state. If the public state does not identify the exact door, retain the available public label.

### Land animation choices

Before a player chooses a land to animate, the battlefield and target picker identify lands that player has gained since their most recent turn began. The hint follows the permanent's continuous control history, including changes of controller. Both older and newly controlled lands remain legal targets when the effect permits them.

An untapped noncreature land can use its tap ability for mana as soon as it comes under the player’s control. After it becomes a creature, recent control prevents it from attacking or paying a tap or untap symbol in an activation cost unless it has haste. The hint accounts for haste granted by the animation and uses conditional wording when another effect could change the outcome. Tests should distinguish two otherwise identical lands and cover an animation that grants haste. [Magic Origins release notes](https://magic.wizards.com/en/news/feature/magic-origins-release-notes-2015-07-08) · [Wilds of Eldraine release notes](https://magic.wizards.com/en/news/feature/wilds-of-eldraine-release-notes)

## Traceability
The previous target-panel implementation's regressions executed successfully in the combined main candidate's [web run](https://github.com/otro-felipe/playmat/actions/runs/44164549318): 1,568 unit tests passed, 42 skipped, with TypeScript, ESLint and accessibility checks passing. That run's overall size gate failed; functional test success alone did not approve deployment. This does not validate the subsequent READ-AC-004 arrow-only change; its gates and browser screenshots are pending execution.

The final [optimized web run](https://github.com/otro-felipe/playmat/actions/runs/44168445091) also passed those checks and the unchanged size gate. Its production-minified Chromium fixture additionally verifies public target receipts at 390×844 and 844×390, pointer-transparent receipts, immediate manual land taps and cancellation. Physical mobile devices and real disconnected transport remain unverified.

| Scenario | Executed regression cases | Remaining checks |
| --- | --- | --- |
| READ-AC-001 | `Mage.Web.Client/src/core/game/publicTargets.test.ts` — `labels players, permanents, graveyards and other spells before they resolve`; `never names private, face-down, hidden or missing objects`. `Mage.Web.Client/src/app/match/StackZone.test.tsx` — `keeps public target names accessible for every waiting spell and ability without a visible panel` | Changed case pending execution; physical mobile device rendering |
| READ-AC-002 | `Mage.Web.Client/src/app/match/GameLog.test.tsx` — `[READ-AC-002] receives turns and resolutions after reconnect, including lines delivered during chatJoin`; `[READ-AC-002] a full log still scrolls to new actions after the bounded buffer stops growing`; `[READ-AC-002] retries an initially refused chat join and receives subsequent actions`; `[READ-AC-002] an old join resolving late cannot leave the newer membership` | Real disconnected mobile transport |
| READ-AC-003 | `Mage.Web.Client/src/core/game/actionPresentation.test.ts` — `captures cast, targets and stack departure across unrendered updates without delaying the real state`; `bounds a burst and accounts for every omitted preview, then drains and resumes`; `discards obsolete receipts on %s and never replays the reconnect snapshot`; `shows battlefield entries and hides the identity of a face-down play`. `Mage.Web.Client/src/app/match/RecentActions.test.tsx` — `presents rapid public actions in order as read-only history while the real stack has advanced`. `Mage.Web.Client/src/app/match/useAutoPass.test.tsx` — `leaves a complete reading beat for a targeted stack object even while passing the turn`; `manual priority responses are immediate during the presentation beat`; `does not answer a newer prompt arriving before React cleans up the old timer`; `rejects the old automated answer after %s`; `rechecks the live settings before executing a previously scheduled automated answer` | Live multiplayer cadence |
| READ-AC-005 | `Mage.Web.Client/src/app/match/MatchStage.test.tsx` — `[READ-AC-005] opens the revealed hand with ineligible cards visible but disabled`. `rust/crates/playmat-host/src/prompts.rs` — `a_revealed_hand_choice_exposes_the_whole_hand_with_only_legal_answers` | Live multiplayer visual check |
| READ-AC-006 | `Mage.Web.Client/src/app/match/MatchStage.test.tsx` — `[READ-AC-006] groups selectable graveyard cards under their seat names` | Physical mobile device rendering |
| READ-AC-007 | `Mage.Web.Client/src/app/match/MatchStage.test.tsx` — `[READ-AC-007] clears the mark after a private zone change and accepts a fresh reveal` and the rollback and reconnect cases in the same suite. RolledBackKnowledgeTest covers serialized restore and a hidden departure with unchanged count. | Physical device reconnect |
| READ-AC-008 | `Mage.Web.Client/src/app/match/StackZone.test.tsx` — `[READ-AC-008] names the cast door %s over the combined artwork`, `[READ-AC-008] shows no door when the stack view does not identify a public Room half`. `Mage.Web.Client/src/app/match/RecentActions.test.tsx` — `[READ-AC-008] announces which Room door unlocked on entry and which unlocked later` | Production match rendering |

## Known limitations
The server does not replay game-chat history on rejoin, so lines broadcast while disconnected cannot be reconstructed by this client change. The reported turn-3 session has no transport trace; regressions reproduce concrete client failure modes, not the exact original connection.

## Arrow-only regression evidence (pending)
- `Mage.Web.Client/src/app/match/stackTargetArrows.test.ts` — `keeps lower spells and their multiple/shared targets with a hierarchy independent of colour`; `excludes private endpoints, replaces the chooser’s announced branch and removes departed objects`; `fans curves and endpoints for shared targets while keeping arrowheads close to the target`; `gives public graveyard and exile targets a pile anchor without exposing private cards`.
- `Mage.Web.Client/src/app/match/Arrows.test.tsx` — `draws every announced branch, including covered spells, with focus and removal independent of the old top-only input`.
- `Mage.Web.Client/src/app/match/StackZone.test.tsx` — `[READ-AC-004] keyboard focus emphasizes a lower spell without dispatching a game action`.
- `Mage.Web.Client/e2e/stack-targets.spec.ts` — `[READ-AC-004] Burst Lightning keeps its arrow to Doge below other spells, without a target panel`, parameterized at 1440×960, 390×844 and 844×390. Tests use synthetic local data, exercise shared/multiple targets and keyboard emphasis, capture screenshots and confirm a manual priority response removes obsolete arrows. CI retains these fixture screenshots even when the checks pass.
