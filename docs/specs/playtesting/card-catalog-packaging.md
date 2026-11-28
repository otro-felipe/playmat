# Packaged card catalog

## PM-CATALOG-AC-01

A private playtesting image includes the executable card classes and the card
catalogs generated from the same engine build. Exact printing lookups and
Pioneer filtering can resolve Way of the Cryomancer (FRA 223), Uldaros Theorix
(FRA 159), and Seasoned Cryomancer (FRA 38). Each card can be instantiated with
its rules in the assembled server.

The root Docker build checks this scenario with
[VerifyPackagedCardCatalog](../../../ops/playtesting/test/VerifyPackagedCardCatalog.java).
The check opens the compiled server's H2 card repository and SQLite export and
fails if an expected printing or executable card implementation is missing.
