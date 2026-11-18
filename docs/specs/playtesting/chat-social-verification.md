# Chat text and human social discovery integration

Validated runtime: `9ef194fe7069345c0a19a3d8742ece4f7dfeddfc`, 2026-11-18.

## Behavior and data preservation

Player chat and whispers decode the server's single HTML4 transport escape, then render as plain React text. Accents, emoji, typed markup and literal entities remain text. Game notices retain their existing formatting. An integration regression reproduced inherited object names such as `&constructor;` decoding into function text; named references now use own dictionary entries only. The same networkless Node 22 fixture failed that assertion before the fix and passed all 48 cases afterward.

Private social discovery uses delegated identities from the authoritative grant registry, including legacy names. Actual product human accounts remain eligible even when their names look like MCP identities. Filtering occurs before directory counting and pagination. No account, grant, authentication rule, match seat, display alias, XP, history, curated friendship or profile is deleted or rewritten. The added product route is loopback/internal metadata; the existing Caddy internal-route block remains in place. Registry failure retains previous discovery behavior rather than guessing which human names to hide. This is presentation filtering, not an authorization boundary; public servers retain their existing behavior.

## Executed gates

- [Web client 44314128596](https://github.com/otro-felipe/playmat/actions/runs/44314128596): typecheck, zero-warning lint, 1,629 unit tests passed (42 opt-in cases skipped), accessibility and build passed. Bundle measurements: entry 79.4/86 kB, initial 211.3/221 kB, all application chunks 830.6/840 kB. Budgets and measurement method are unchanged.
- The same web run passed seven ordinary preview cases and 19 explicitly built, production-minified Chromium fixtures. Four new chat/social cases cover desktop and phone, Spanish/Unicode, one-pass escaping, inert hostile HTML, aliases, lists/counts, directory search and direct profiles. The test fixture entry is omitted from ordinary production builds. Screenshots are retained in `chat-social-ui-fixtures`; desktop, phone, literal-text, directory and profile images were visually inspected.
- [Full Java reactor 44314117297](https://github.com/otro-felipe/playmat/actions/runs/44314117297): successful, including social directory/filter tests and existing protocol contracts.
- [MCP and real-engine sequences 44314117366](https://github.com/otro-felipe/playmat/actions/runs/44314117366): successful, preserving causal resolution and opponent-action interruption behavior.
- [Complete image 44314123297](https://github.com/otro-felipe/playmat/actions/runs/44314123297): successful. The freshly isolated PostgreSQL fixture executed 36 product/OAuth/event tests, including delegated discovery and retained grants; two explicitly optional SDK/browser cases were skipped. MCP passed 121 tests with three live cases skipped. Consistent backup/restore, actual Java restore locking, three forced engine restarts through modified sideboarding/game two, match completion and an actual 60-second idle expiry despite polling/resync also passed.

No production account or active game was used for this validation. Physical Safari and an authenticated production match UI were not tested. The separate semantic `play_turn` implementation is not part of this change and still requires its own integration review. Any later rollout requires a fresh healthy zero-active-game gate and preservation of the existing private data/configuration.
