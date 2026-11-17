# Integrated candidate — 2026-11-17

Worktree: `playmat-one-shot`, branch `feat/private-playtesting`.

- Base `ccdfe6807c4d195bfaccb7968d7a88d4589b570f`: Freeform drafts and independent deck updates preserved.
- `6ccc55ca`: MCP guide bootstrap, turn-boundary protection and explicit rollback votes.
- `0af681cb`: cherry-pick of OAuth client registry `19f8176fba13d27de707beff3e9abceca413e5b5`.
- The turn-planning guide also documents spell/payment batching, an explicit pass followed by opponent priority, bounded holds and their actual limitations.

## Local verification

All project commands ran in Docker on the personal MacBook Pro. No production credentials or game actions were used in tests.

| Check | Result |
| --- | --- |
| Product suite with disposable PostgreSQL 17, official MCP SDK and Chromium enabled | 35 passed, 0 skipped |
| MCP build and full fixture suite after integration | 25 passed, 2 live tests skipped |
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

Source publication is separately blocked: automatic approval review rejected `git push origin feat/private-playtesting` to `https://github.com/otro-felipe/playmat.git`, requiring explicit destination authorization. After verifying this is the existing public fork, the caller has ADMIN permission, and the tracked remote already contains `ccdfe680`, one retry was also denied for that reason. Neither push executed. Do not retry without materially new authorization evidence.

After the blockers are resolved, publish the branch, deploy the integrated candidate to the exact Railway service above, observe terminal `SUCCESS`, then verify effective commit, health, OAuth registration metadata and frontend assets. Do not claim deployment success from an upload or queued build. OAuth client support and remaining per-client acceptance limits are detailed in [OAuth verification](oauth-verification.md).
