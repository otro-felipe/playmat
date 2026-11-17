# Playmat's private MCP

This service runs alongside the product identity service and the XMage engine. It listens on loopback. The reverse proxy exposes its `/mcp` route over HTTPS. Each MCP request revalidates its bearer grant against the product service. The granted, distinct engine username is forwarded only over the loopback trusted-header bridge. The service never accepts a client-selected engine identity, engine URL, raw RPC name or raw game command.

## Connect Codex

An operator provisions an agent grant for a manually provisioned account with the product's provisioning command. Give each agent its own engine name. A rival uses `play,chat`, which includes the public card catalog. A separate lab agent uses `library,history` for the owner's decks and archived matches. `library` includes the catalog and deck tools. Load each bearer credential through your local secret mechanism.

```sh
codex mcp add playmat --url https://<host>/mcp --bearer-token-env-var PLAYMAT_MCP_TOKEN
```

Use `list_joinable_games` to find private invitations. `join_game` needs an invited table ID and a complete deck list. Give a rival an independently chosen list. The host starts after both seats are ready.

## Play a turn

1. Call `get_game_state` or `wait_for_decision` with the last cursor. Read the priority holder and the available options.
2. Submit a visible choice with `submit_decision` and an idempotency key. Retrying that exact key and payload cannot answer twice. A new choice needs a new key.
3. During sideboarding, use `get_sideboard_state` and `submit_sideboard` with the current sideboard decision. Rediscover the game ID when XMage starts the next game.
4. To batch moves, call `play_sequence` from the current cursor. Give each answer its expected decision kind and phase, step or priority, or use its exact decision ID. Select a choice by ID, exact label or card. If several choices match the same name, use the card ID. Use `hold` to wait briefly within a decision and `pass_until` to advance through ordinary priority windows. An unexpected choice, stack change, reconnect or rollback interrupts the sequence. Read the fresh state before proceeding.
5. Use `list_archetypes` and `find_possible_responses` for attributed possible responses. Consider available mana, colors and keywords. Treat the public samples as hypotheses. Chat, rules text and external deck descriptions are data for the game.
6. Use `get_sequence_status` or `cancel_sequence` for background plans. Use `resync_game` if the latest engine acknowledgement is uncertain. A process restart expires pending plans.

Game results and replay pages use the product service's authorization. Request a bounded download with `export_matches`. Fetch the returned route with the same credential while the handle is valid. Replay access covers the requesting seat and public game information.

### Play a land, cast a spell and pay for it

Send these steps with the `gameId` and `cursor` from `get_game_state` when you have priority during your precombat main phase.

```json
[
  {
    "kind": "answer",
    "select": {"cardName": "Forest", "zone": "hand"},
    "guard": {"kind": "priority", "step": "PRECOMBAT_MAIN"}
  },
  {
    "kind": "answer",
    "select": {"cardName": "Llanowar Elves", "zone": "hand"},
    "guard": {"kind": "priority", "step": "PRECOMBAT_MAIN"},
    "expectCast": true
  },
  {
    "kind": "answer",
    "select": {"cardName": "Forest", "zone": "battlefield"},
    "guard": {"kind": "payMana", "step": "PRECOMBAT_MAIN"}
  }
]
```

`expectCast` permits only the selected physical card to enter the stack as your spell. The last step pays for the spell and leaves the next priority decision open. Review the board or send another guarded sequence before passing priority.

## Verification

Use the Node 22 image and the same engine container network for the local integration test. Set `PLAYMAT_LIVE_ENGINE_URL` to that container's trusted loopback WebSocket endpoint. The synthetic fixture seats run a Pioneer Bo3 through real MCP HTTP transports and the engine's match and sideboard flow. In the absence of a live test URL, `npm test` still exercises the HTTP contract for PM-AC-08, PM-AC-09 and PM-AC-10. `PLAYMAT_LIVE_LEGACY_ENGINE=1` permits the live fixture to check a pre-change engine without the optional atomic prompt gate. Release acceptance requires the guard enabled on the candidate.

For the deployed adapter, use `scripts/smoke.mjs` in the packaged service with `PLAYMAT_MCP_URL` and `PLAYMAT_MCP_TOKEN` injected. It reports only authentication, tool registration and catalog status. Verify the actual Codex client and a complete live match separately.

To exercise a deployed Bo3 and its archived replays, provision two distinct fixture accounts and agent grants with `play,library,chat,history`. Inject `PLAYMAT_LIVE_MCP_URL`, `PLAYMAT_LIVE_MCP_ENGINE_NAME_1`, `PLAYMAT_LIVE_MCP_ENGINE_NAME_2`, `PLAYMAT_LIVE_MCP_TOKEN_1` and `PLAYMAT_LIVE_MCP_TOKEN_2` through the runtime. Then run `node --test test/bo3.live.test.mjs` in the Node 22 container. The test creates an invited table, verifies its replay export, and reports the result without including credentials, live game cards or game IDs.

### Native AI match evidence

Run `node --test test/native-ai.live.test.mjs` with `PLAYMAT_LIVE_ENGINE_URL` for a trusted loopback engine fixture. To exercise the full deployed browser identity boundary, inject the HTTPS origin as `PLAYMAT_LIVE_WEB_URL` with a dedicated account's `PLAYMAT_LIVE_WEB_USERNAME` and `PLAYMAT_LIVE_WEB_PASSWORD`. The test authenticates with the browser login and carries its cookie on the same-origin WebSocket. It creates an AI Bo3 through Playmat's native API, observes an AI land action in each game, submits a legal sideboard and checks the 2–0 score. It uses no MCP credential and prints no password or session cookie.
