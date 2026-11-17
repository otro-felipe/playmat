# Integrated candidate — 2026-11-17

Worktree: `playmat-one-shot`, branch `feat/private-playtesting`.

- Base `ccdfe6807c4d195bfaccb7968d7a88d4589b570f`: Freeform drafts and independent deck updates preserved.
- `6ccc55ca`: MCP guide bootstrap, turn-boundary protection and explicit rollback votes.
- `0af681cb`: cherry-pick of OAuth client registry `19f8176fba13d27de707beff3e9abceca413e5b5`.
- The turn-planning guide also documents spell/payment batching, an explicit pass followed by opponent priority, bounded holds and their actual limitations.
- The final cast-zone patch permits a currently legal visible spell from hand, exile or graveyard, including another player's public zone. It preserves the selected physical card, casting controller and stack checks. Eight new regressions cover supported zones and rejected non-cast expectations.
- Follow-up `e1145119` preserves legal selection across every public battlefield, with six regressions covering opposing targets, duplicate names, exact card IDs, illegal objects and hand isolation.
- Conditional-line integration adds deliberate standalone passing, `yield_priority`, opt-in expected-spell resolutions, empty-stack conditions and conservative public-opponent interruption guards. Opponent waits pause the active budget within a fifteen-minute wall limit. Restart persistence and PvP game recovery are not included.

## Local verification

All project commands ran in Docker on the personal MacBook Pro. No production credentials or game actions were used in tests.

| Check | Result |
| --- | --- |
| Product suite with disposable PostgreSQL 17, official MCP SDK and Chromium enabled | 35 passed, 0 skipped |
| MCP build and full fixture suite after conditional lines and selector integration | 62 passed, 2 live tests skipped |
| Independent two-spell regression | Passed: exact mana-source selection, separate source taps, both expected resolutions, final end step in the same turn |
| Frontend build with private-playtesting flags | Passed; existing large-chunk warning |
| Modal, invitation bootstrap and deck-sync component/store regressions | 7 passed |
| Chromium rollback UI fixture | 2 passed: Escape, outside mouse/touch, focus, both votes and queued requests |
| TypeScript, accessibility coverage and ESLint for affected UI/tests | Passed |
| Integrated Caddy configuration including `/oauth/register` | Valid |
| `git diff --check` | Passed |

## Publication status

The existing Railway project is `playmat-playtesting` (`e1ad2c1e-17af-43f4-9721-38ee15e8d4a4`), environment `production` (`c52e5660-847a-417a-b624-e983205e8295`), service `playmat` (`cdb36263-f818-4f1e-8653-76028e74c624`). Its source has no connected GitHub repository. The current successful deployment observed was `f0849069-cb48-46c6-87d9-e9cf69a72261`, running `ccdfe6807c4d195bfaccb7968d7a88d4589b570f`.

The public `/healthz` check returned healthy with two active/running games. OAuth discovery still lacked `registration_endpoint`, consistent with the previous production build. No candidate component has been applied to production.

The entrypoint starts product, XMage, MCP and Caddy under one parent. It exits after any child exits and then terminates all children. A full deploy or an individual child restart would interrupt the running engine. SSH inspection could not proceed because Railway reported no registered SSH keys. No key or account setting was changed. Deployment is therefore deferred until active games are finished or a separately approved, verified nondisruptive path exists. The frontend artifact is built locally; it has not been uploaded. A browser refresh alone currently provides no new fixes.

Source publication was initially blocked: automatic approval review rejected `git push origin feat/private-playtesting` to the public `otro-felipe/playmat` fork, requiring explicit destination authorization. Neither rejected attempt executed. The owner subsequently approved that exact destination and branch, with the requirement to exclude all secrets. The final outgoing commit history and file snapshots must pass the secret/sensitive-data review before the authorized push; verify the remote branch hash afterward.

After the blockers are resolved, publish the branch, deploy the integrated candidate to the exact Railway service above, observe terminal `SUCCESS`, then verify effective commit, health, OAuth registration metadata and frontend assets. Do not claim deployment success from an upload or queued build. OAuth client support and remaining per-client acceptance limits are detailed in [OAuth verification](oauth-verification.md).
