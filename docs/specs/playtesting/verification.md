# Private playtesting verification

[Acceptance criteria](one-shot.md) · [Docker and Railway operations](../../../ops/playtesting/README.md) · [MCP playbook](../../../ops/playtesting/mcp/README.md)

The Railway pilot served revision `4a491617c24fa8ecaaab024980ae4a82bc772c87` during final verification. The BDD fixtures use separate accounts and deterministic concessions to close their matches.

## Follow-up from the live Pioneer Bo3

The candidate at `e4cc5b7a` built the combined Docker image and ran against local PostgreSQL and XMage. The integration seated a play-scoped delegate from the host's account through an MCP-mode link, preserved separate engine identities and the visible alias, then applied a land, creature spell and mana payment through one `play_sequence` call. Separate MCP and PostgreSQL tests cover guarded ability selection, link concurrency, revocation and interactions that stop a sequence.

The board tests cover the single phase label, stable action controls, live draw animation and participant chat. Chromium confirmed that the short and long primary actions occupy the same bounds and that space types into chat on desktop and on a 390 × 844 touch viewport. The Chromium layout check used a synthetic WebSocket view.

## Repeatable evidence

| Scenario | Evidence | Remaining acceptance |
| --- | --- | --- |
| PM-AC-01, PM-AC-02 | MatchStage and interaction integration tests cover the active phase, changing priority, stack action, and current-turn stops. | Exercise stops and the full-control path across a real opponent's turn. |
| PM-AC-03 | Chromium with a 390 × 844 touch viewport drove the real XMage engine, inspected and played a card, tapped a phase stop and typed into chat. | Physical phone, combat targets and blockers, and installed-mode play. |
| PM-AC-04 | PostgreSQL tests cover provisioned sessions, exclusive guest admission, forged identity, and revocation. Railway checks the forged WebSocket identity, authenticated upgrade, denied anonymous MCP and both provisioned browser sign-ins. Chromium uses the actual copied join link. | Participant acceptance. |
| PM-AC-05 | PostgreSQL tests cover shared ownership and stale revisions. XMage validates a deck before seating it. | Full Bo3 sideboarding acceptance for Standard and Modern. |
| PM-AC-06 | Two Chromium contexts complete Pioneer 2–0 locally and on Railway. The Railway run covers the private invite, chat, sideboard privacy, wait for the other seat and Game 2. The deployed MCP test completes the same progression through remote clients. | Play competitively with the actual participants. |
| PM-AC-07 | Java tests cover vote expiry, rejection, acceptance, and guarded prompts. | A complete live rewind with browser, MCP and replay assertions in the same match. |
| PM-AC-08 | Remote MCP clients play a Railway Pioneer Bo3 through distinct authorized seats, including opponent-turn priority. The harness uses deterministic concessions to close the fixture. A deployed permission check confirms that the rival cannot read library or history and that the previous combined grant was revoked. | A separately played Bo3 with the Codex rival. |
| PM-AC-09, PM-AC-10 | MCP transport tests cover a timed hold, interruption by a new meaningful response, catalog filters and public-only response suggestions. | Exercise a held sequence against a human response on the live engine. |
| PM-AC-11, PM-AC-12 | PostgreSQL tests cover failed archive retry, interrupted sideboarding and recovery of finished matches, scoped exports, and deck-version statistics. The deployed Bo3 verifies both archive pages and the authorized ZIP. After redeploy, the completed result, replay page hashes and ZIP entry hashes match, and the unrelated account still receives 404. | The pilot uses Railway's S3-compatible bucket. Direct AWS S3 acceptance remains open. |
| PM-AC-13 | A provisioned seat completed a Bo3 against native XMage over Railway's web protocol. The test observes AI play in both games and closes the fixture with deterministic concessions. | Test rollback behavior against native AI before relying on it. |

## Commands

Run these in the corresponding Docker containers. Use Node 22 for the product, MCP, and Vitest tests, and the Playwright image matching the lockfile for browser tests. Supply deployment credentials through a secret mechanism at runtime.

```sh
# Engine root, with the pinned card jar installed from the Dockerfile
mvn -B -q -pl 'Mage.Server,!Mage.Sets' -am \
  -Dtest=SideboardPoolTest,RollbackVoteTest,PendingPromptTest \
  -Dsurefire.failIfNoSpecifiedTests=false test

# Mage.Web.Client
npx vitest run src/app/match/MatchStage.test.tsx src/app/stores/session.test.ts
MAGE_E2E_REQUIRE_SERVER=1 npx playwright test e2e/app-tables.spec.ts --grep PM-AC-06
npx playwright test e2e/app-private-bo3.spec.ts --workers=1

# ops/playtesting/product, with PLAYMAT_TEST_DATABASE_URL set to a fixture PostgreSQL database
node --test product.test.mjs

# ops/playtesting/mcp, after npm run build
node --test test/acceptance.test.mjs test/product.test.mjs
node --test test/bo3.live.test.mjs
node --test test/native-ai.live.test.mjs
```

The private browser test uses `PLAYMAT_PRIVATE_BASE_URL` and `MAGE_WEB_E2E_BASE_URL` for the same HTTPS origin, plus `PLAYMAT_PRIVATE_QA_A_USERNAME`, `PLAYMAT_PRIVATE_QA_A_PASSWORD`, `PLAYMAT_PRIVATE_QA_B_USERNAME`, and `PLAYMAT_PRIVATE_QA_B_PASSWORD` for separate fixture accounts. Keep screenshots, video, traces, and debug logging disabled for this test.

## Current data model

PostgreSQL stores owned library revisions, relational game and match summaries, participant statistics, and replay metadata. The replay records the exact in-game deck composition for each seat, including sideboard changes. Aggregation groups by that composition's fingerprint. The played configuration has no foreign key back to a particular saved library revision. Individual typed events live in the versioned S3 replay, and the product reads and filters those events for the authorized perspective.
