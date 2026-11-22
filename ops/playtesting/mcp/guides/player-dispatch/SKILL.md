---
name: player-dispatch
description: Assign an approved MTG Eigen invitation to an available MCP player, create a persistent slot when needed, and hand off that seat to a match pilot.
---

# Assign a player to an approved match

Use the account's existing OAuth connection. In Sheoldred, the Discord application verifies Felipe's approval for the specific request before starting a paid pilot or provisioning a slot. Keep the approval, selected table, format, intended deck, slot request UUID and assigned player together when resuming a job.

1. Read the current tool schemas and call `get_guide({"bundle":true})`. Look up the approved table with `list_joinable_games({"tableId":"<invited-table-uuid>"})`. Compare its exact `tableId`, format and recipient to the request. A spectator link or a table ID is only a reference. Continue only with a confirmed invitation. If the exact lookup returns no invitation, ask the host to check the recipient.
2. Use `list_players({"availableOnly":true})`. For an exact `guestPlayerId`, select that same player. If it is busy, report the conflict. For an account invitation marked `requiresPlayerAssignment:true`, select a free player owned by that account. An unbound reservation already occupies the slot. For a resumed job check the previously assigned player's reservation before allocating anything else.
3. If an account-addressed invitation has no free player and the approved request allows provisioning, call `create_player_slot({"requestId":"<persisted-request-uuid>","displayName":"Sheoldred 3"})`. Retry with the same UUID and settings. The account owner must have consented to `players:manage` on the canonical connection. A new player also needs the connection's play permission to enter the table. If provisioning is unavailable, report it to the owner.
4. Call `list_decks({"playerId":"<selected-player-uuid>"})` and choose the authorized saved MCP deck for the requested format. Verify the identity of the intended list when names coincide. Join using its returned ID through `join_game({"tableId":"<invited-table-uuid>","playerId":"<selected-player-uuid>","deckId":"<validated-deck-uuid>"})`. If a concurrent job took the slot, recheck the invitation and availability. On an uncertain join, call `get_player_reservation({"playerId":"<selected-player-uuid>"})` and reconcile that same table before retrying.
5. Hand the fresh pilot the table, format, deck name and its own player ID. The host starts the match. The pilot reads the live guides and plays through its own seat until the terminal result. The coordinator retains account-wide provisioning and dispatch authority.

A human host can choose **Rival MCP**, enter the invited account name or an exact player UUID, then use **Copy table ID** in Tables. An MCP host can set `guestAccountName` or `guestPlayerId` on `create_game`. Existing invitations to the host's own default MCP seat follow their original instructions.
