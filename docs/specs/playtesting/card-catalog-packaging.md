# Packaged card catalog

## PM-CATALOG-AC-01

A private playtesting image includes the executable card classes and the card
catalogs generated from the same engine build. Exact printing lookups and
Pioneer filtering can resolve Jace's Machinations (FRA 32), Seasoned Cryomancer
(FRA 38), Extrapolate the Impossible (FRA 55), Sanctum Lurker (FRA 64),
Null Summoner (FRA 142), Uldaros Theorix (FRA 159), Way of the Cryomancer
(FRA 223), and Loot, the Anomaly (FRA 232). Each card can be instantiated with
its rules in the assembled server.

The root Docker build checks this scenario with
[VerifyPackagedCardCatalog](../../../ops/playtesting/test/VerifyPackagedCardCatalog.java).
The check opens the compiled server's H2 card repository and SQLite export and
fails if an expected printing or executable card implementation is missing.

## Reality Fracture gameplay

The [FRA engine tests](../../../Mage.Tests/src/test/java/org/mage/test/cards/single/fra)
exercise the new cards in games. `SeasonedCryomancerTest` covers the sequence of
drawing and discarding, the stun trigger, and the graveyard activation.
`ExtrapolateTheImpossibleTest` covers the optional sideboard reveal and the
opponent's choice. `NullSummonerTest` covers the linked exile and threshold for
casting and spending mana. `LootTheAnomalyTest` covers negative power in combat
and threshold at activation. Upstream's `JacesMachinationsTest`,
`SanctumLurkerTest`, and `UldarosTheorixTest` cover their respective rules.
