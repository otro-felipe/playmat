# Permanent spell resolution evidence — PM-AC-09-CREATURE

## Verified defect
Baseline: `f5f0ed34b19`, the integrated local `main` at investigation start.

`GameEventRecorder` recorded a stack resolution only from `RESOLVING_ABILITY`. `Spell.resolve` invokes that path for an instant/sorcery's abilities, but its ordinary permanent branch moves the card to the battlefield directly. In particular, the real `MonasterySwiftspear` spell reaches `Player.moveCards(..., BATTLEFIELD, ...)` without that ability event. Its removal therefore lacked evidence and the sequence guard correctly rejected the unwitnessed stack change as `state_changed`.

There was a second observability problem: multiple ability events while one stack object resolves incremented the revision more than once for the same object, potentially advertising an evidence gap.

This establishes concrete engine defects, not the exact cause of the reported live incident. The original `play_sequence` arguments and adjacent public snapshots were requested from the coordinator but were unavailable during this verification. No active match was queried or changed.

## Change
Observe the actual public stack object once at the production entry of `GameImpl.resolve`, before test collectors and `top.resolve` can run effects. Real games do not delegate to `SpellStack.resolve`. Keep the observer on that separate helper entry as well: its checked-in callers are AI simulations in `CombatUtil` and focused tests. These paths do not call each other, and both suppress observations in simulations. Deliver its public stack ID through the existing runtime-only observation facility to the game's feed. Remove the per-ability-event producer. Do not create a `GameEvent`, change priority, relax `GameSeat` checks or export a physical/private card ID. Simulations emit nothing. Observer failure cannot change resolution and makes evidence unavailable.

## Integration correction: canonical game entry

The first candidate `be6d2b34` covered `SpellStack.resolve` but removed the ability watcher without covering `GameImpl.resolve`. Its Java tests exercised the helper directly, even when they used a real `Spell` or card. Real `GameImpl.resolve` instead peeks the stack and calls `top.resolve(this)` directly. Therefore that candidate supplied no resolution witness in a real match. The integrated real burn fixture failed with `opponent_state_changed` after three completed steps/four applied decisions. That failure is distinct from the initial permanent-spell defect and was not accepted as a passing game result.

`GameImplResolutionEvidenceTest` now enters the actual `GameImpl.resolve` implementation through a `FakeGame` subclass. The Swiftspear and Lightning Bolt cases use their real card and `Spell.resolve` code; only the external player movement/damage boundaries and unrelated post-effect bookkeeping are stubbed to assert that the public witness already exists. The modal instant traverses the real two-mode spell resolution loop and two ability events while asserting one public resolution revision. Separate cases verify canonical simulation suppression and observer failure without suppressing the actual resolution. This does not claim a complete running Java match.

In disposable, networkless `playmat-creature-java:test` containers, Java 17 `javac --release 8` compiled the current `GameImpl` and observation/feed classes against existing local runtime libraries and JUnit 4.13.2. Before the correction, twelve cases ran: all three new canonical positive cases failed specifically with expected witness `1`, observed `null`, while the nine helper cases passed. After the two-line canonical hook, those twelve passed. After adding canonical simulation/failure negatives, all fourteen passed. `GameSeat` and its guards were unchanged. A fresh full reactor and complete-image real-game acceptance are still required during integration.

## Earlier deterministic helper evidence
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

## Integration verification
The corrected runtime `f1dedd8813a1e029e07fdb23866b4f0f4bd0f544` passed integration on 2026-11-18:

- Full Java reactor: [44308721461](https://github.com/otro-felipe/playmat/actions/runs/44308721461), successful.
- MCP and complete-image real-engine sequence: [44308720683](https://github.com/otro-felipe/playmat/actions/runs/44308720683), 121 tests passed and three opt-in tests skipped. The running Java fixture completed two own damage resolutions through the original end step and separately interrupted on a real rival mana activation. Four own-effect regressions still fail on the deployed baseline as the controlled negative comparison.
- Complete-image recovery, consistent backup/restore and idle acceptance: [44308726891](https://github.com/otro-felipe/playmat/actions/runs/44308726891), successful, including three forced restarts through modified sideboarding/game two, an actual Java restore-lock check and a deliberately configured 60-second inactivity expiry despite polling/resync.

These results validate the corrected runtime, not the original helper-only candidate. No live-match reproduction was performed. UI/typecheck work is unaffected because no frontend TypeScript or layout changed. This evidence fix does not implement the separately planned semantic `play_turn` contract.
