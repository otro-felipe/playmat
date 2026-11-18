# Permanent spell resolution evidence — PM-AC-09-CREATURE

## Verified defect
Baseline: `f5f0ed34b19`, the integrated local `main` at investigation start.

`GameEventRecorder` recorded a stack resolution only from `RESOLVING_ABILITY`. `Spell.resolve` invokes that path for an instant/sorcery's abilities, but its ordinary permanent branch moves the card to the battlefield directly. In particular, the real `MonasterySwiftspear` spell reaches `Player.moveCards(..., BATTLEFIELD, ...)` without that ability event. Its removal therefore lacked evidence and the sequence guard correctly rejected the unwitnessed stack change as `state_changed`.

There was a second observability problem: multiple ability events while one stack object resolves incremented the revision more than once for the same object, potentially advertising an evidence gap.

This establishes concrete engine defects, not the exact cause of the reported live incident. The original `play_sequence` arguments and adjacent public snapshots were requested from the coordinator but were unavailable during this verification. No active match was queried or changed.

## Change
Observe the actual public stack object once at the entry of `SpellStack.resolve`, before its effects begin. Deliver its public stack ID through the existing runtime-only observation facility to the game's feed. Remove the per-ability-event producer. Do not create a `GameEvent`, change priority, relax `GameSeat` checks or export a physical/private card ID. Simulations emit nothing. Observer failure cannot change resolution and makes evidence unavailable.

## Deterministic evidence
All dependency and runtime commands ran in disposable Docker containers. The MCP runner rebuilt the current `engine-core.mjs` with pinned package-lock dependencies. It had no external network during tests. The Java runner compiled the changed Java classes against the existing local Playmat runtime libraries under Java 17, with JUnit 4.13.2; this is narrower than a full Maven reactor/image rebuild. The real Swiftspear/Spell path uses a stubbed `Player.moveCards` boundary to inspect evidence before movement; it does not claim a complete running match.

| Boundary | Cases | Result |
| --- | --- | --- |
| Before fix | `GameEventRecorderEvidenceTest.permanentSpellResolutionIsWitnessedBeforeMovingToBattlefieldWithoutAbilityEvent` | Failed: expected resolution 1, observed null |
| Before fix | `GameEventRecorderEvidenceTest.oneStackResolutionWithMultipleAbilityEventsIsWitnessedOnlyOnce` | Failed: expected revision 1, observed 2 |
| After fix | The above cases plus existing feed guards, `monasterySwiftspearActualSpellPathProducesPublicEvidenceBeforePermanentMovement`, `failedResolutionObserverDoesNotPreventResolutionAndDisablesEvidence`, `simulatedStackResolutionDoesNotPublishEvidence` | 9 Java tests passed, 0 failed |
| MCP contract | `test/sequence-own-creature.test.mjs`: `[PM-AC-09-CREATURE] declared Swiftspear resolves and continues from land/payment through attack: normal` and `mid-resolution` | Passed; exact seven actions asserted, including attack and confirmation |
| MCP negative boundary | Same file: `[PM-AC-09-CREATURE] does not attack after missing-evidence`, `rival-action`, `rival-spell`, `unexpected-trigger` | Passed; exactly four decisions applied, no attack |
| Complete MCP suite | `npm run build`, `node --test test/*.test.mjs` in the isolated runner | 121 passed, 3 opt-in live tests skipped, 0 failed |

The first full-suite attempt omitted the product's pure `sequence-driver.mjs` from the temporary runner and failed to import it. After mounting that exact source file read-only, all 124 cases completed with the results above. An earlier targeted invocation likewise lacked the generated engine bundle; it was rebuilt before the full suite. Neither import failure is counted as behavioral regression evidence.

## Remaining validation
Run the normal Java reactor and complete-image sequence acceptance during integration. No production deployment or live-match reproduction was performed. UI/typecheck work is unaffected because no frontend TypeScript or layout changed.
