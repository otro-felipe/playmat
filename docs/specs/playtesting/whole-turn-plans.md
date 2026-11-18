# Whole-turn causal plans

## PM-AC-09-TURN — Contract
An agent may submit a bounded complete-turn plan, including known spells, targets, costs, triggered abilities, combat and a final safe advance to its next turn. It SHALL never infer unavailable actions from zero mana, answer for the rival, or continue through a real rival non-pass action or newly learned private/random information.

`play_turn` accepts significant `play`, guarded `choose`, `attack` and optional `pace` intentions. The executor SHALL supply legal ordinary priority passes between these intentions; the caller need not enumerate passes or predict exact priority handoffs. `finish` selects safe next-turn advance, this turn's end step, or no phase advance. The final declared spell still settles with `finish:none`. Unknown mandatory decisions, configured stops and impossible intentions return control before another action. Limits are 32 intentions, 96 compiled actions, 80 passes, sixty active seconds and fifteen minutes wall time. Legacy guarded sequences remain supported.

Explicit `expectedStackIds` adopts exact objects already visible at the initial cursor. Resolution permission applies to those objects and the plan's explicitly declared casts/triggers, including automatic resolution before the next pass step. Unknown objects and evidence gaps still interrupt. Public derived hints remain observable but SHALL NOT be part of the rival-action fingerprint.

Explicit `allowPlannedCombatDamage` accepts only continuously witnessed own combat damage from known declared attackers, and only the exact corresponding rival life decrease. An unrelated simultaneous public change still interrupts. New combat evidence is required; absence of a rival action alone is insufficient.

An answer with `skipIfTargetedBy` may be skipped only when its exact public target is already announced on the exact own planned spell. It must not consume the current different prompt or treat an absent prompt as evidence. Optional hidden-zone costs cannot use this shortcut.

Semantic targets use `{select, instruction}`. An unresolved target requires its exact instruction guard; omission is allowed only for the above publicly proven auto-selection case. Mandatory `choose` intentions require an exact instruction guard. Payment selects current legal resources and cannot stand in for an omitted target/cost. An acknowledgement that precedes the cast's new snapshot SHALL NOT count as resolution or completion.

`expectTargetTriggers` is separate from own `expectTriggers`. It accepts only an exact Ward ability from a visible opposing target, tied to a declared own targeting spell and its announced target. A subsequent question/discard must use a matching guarded answer and a current legal choice. Ward does not authorize arbitrary rival triggers or decisions for the rival.

## Evidence scope
The permanent-resolution observer integrated at `3f4e4b47326` covered `SpellStack.resolve`, but isolated real-engine QA proved the live game calls `GameImpl.resolve` and directly invokes `top.resolve(this)`. Its life-change view still had resolution revision zero. This change observes that live entry before effects, with no rules event and no simulation observation. A regression invokes the actual `GameImpl` caller: it fails against the unchanged baseline with missing evidence and passes with the fix.

Other regressions model early Talent/prowess resolution, own combat damage, cast-time daybound hints (including graveyard cards), delayed Burst Lightning effects, Ward/discard and auto-selected targets. They preserve the Wrenn's Resolve/new-exile and genuine rival-response interruptions. No real user game is queried or changed.

Combat permission is intentionally narrow: witnessed own damage to the rival player's life. Poison, planeswalker damage, combat destruction or other collateral changes need a fresh plan. Information evidence exposes only a monotonic revision: private random events change only their owner's view; a random effect with an already-public origin changes all viewers' revisions. It never carries random outcomes or private object identities.
