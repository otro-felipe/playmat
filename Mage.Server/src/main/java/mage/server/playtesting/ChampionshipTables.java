package mage.server.playtesting;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import mage.cards.decks.DeckCardLists;
import mage.constants.TableState;
import mage.game.Table;
import mage.game.match.ChampionshipRules;
import mage.game.match.MatchOptions;
import mage.players.PlayerType;
import mage.server.TableController;
import mage.server.User;
import mage.server.managers.ManagerFactory;
import mage.server.websocket.rpc.JsonCodec;

import java.util.Optional;
import java.util.UUID;

/** Real XMage tables for product tournaments; no client can choose a rival's seat or registered deck. */
public final class ChampionshipTables {
    private final ManagerFactory managers;

    public ChampionshipTables(ManagerFactory managers) { this.managers = managers; }

    public synchronized JsonObject execute(JsonObject command) throws Exception {
        UUID pairing = UUID.fromString(command.get("pairingId").getAsString());
        String action = command.get("action").getAsString();
        TableController controller;
        if (action.equals("prepare")) {
            Optional<TableController> existing = managers.tableManager().getControllers().stream()
                    .filter(c -> c.getOptions() != null && c.getOptions().championship != null
                            && c.getOptions().championship.pairingId.equals(pairing)).findFirst();
            controller = existing.isPresent() ? existing.get() : prepare(pairing, command);
        } else {
            UUID tableId = UUID.fromString(command.get("tableId").getAsString());
            controller = managers.tableManager().getController(tableId).orElse(null);
            if (controller == null || controller.getOptions() == null || controller.getOptions().championship == null
                    || !pairing.equals(controller.getOptions().championship.pairingId)) return null;
        }
        final Table table = controller.getTable();
        ChampionshipRules rules = controller.getOptions().championship;
        JsonObject view = new JsonObject();
        if ("cancel".equals(action)) {
            if (table.getState() == TableState.WAITING || table.getState() == TableState.READY_TO_START || table.getState() == TableState.STARTING) {
                managers.tableManager().removeTableByStaff(table.getId());
            }
        } else if ("status".equals(action) || "launch".equals(action)) {
            if (command.has("deadlineAt")) rules.deadlineAt = deadline(command);
            if ("launch".equals(action) && (table.getState() == TableState.WAITING || table.getState() == TableState.READY_TO_START || table.getState() == TableState.STARTING)) {
                User a = online(rules.seatA);
                User b = online(rules.seatB);
                if (a == null || b == null) return null;
                JsonArray decks = command.getAsJsonArray("decks");
                if (!controller.joinChampionshipTable(a, JsonCodec.GSON.fromJson(decks.get(0), DeckCardLists.class))
                        || !controller.joinChampionshipTable(b, JsonCodec.GSON.fromJson(decks.get(1), DeckCardLists.class))) return null;
                if (table.getState() == TableState.READY_TO_START) table.setState(TableState.STARTING);
                controller.startMatch();
            }
        } else if ("attach".equals(action)) {
            String engineName = command.get("engineName").getAsString();
            User user = online(engineName);
            if (user == null || !(rules.seatA.equalsIgnoreCase(engineName) || rules.seatB.equalsIgnoreCase(engineName))) return null;
            UUID seat = controller.getUserPlayerMap().get(user.getId());
            if (seat != null) view.addProperty("ownGamePlayerId", seat.toString());
        } else if (!"prepare".equals(action)) throw new IllegalArgumentException();
        view.addProperty("tableId",table.getId().toString());
        view.addProperty("state",table.getState().name());
        view.addProperty("seatAOnline",online(rules.seatA) != null);
        view.addProperty("seatBOnline",online(rules.seatB) != null);
        if (table.getMatch().getGame() != null) view.addProperty("gameId",table.getMatch().getGame().getId().toString());
        return view;
    }

    private TableController prepare(UUID pairing, JsonObject command) {
        int bestOf = command.get("bestOf").getAsInt();
        if (bestOf != 3 && bestOf != 5) throw new IllegalArgumentException();
        String format = command.get("format").getAsString();
        if (!java.util.Arrays.asList("Standard","Pioneer","Modern").contains(format)) throw new IllegalArgumentException();
        JsonArray players = command.getAsJsonArray("players");
        String a = players.get(0).getAsString(), b = players.get(1).getAsString();
        if (a.equalsIgnoreCase(b) || a.isEmpty() || b.isEmpty()) throw new IllegalArgumentException();
        MatchOptions options = new MatchOptions("Tournament " + pairing, "Two Player Duel", false);
        options.setDeckType("Constructed - " + format);
        options.setWinsNeeded(bestOf / 2 + 1);
        options.setQuitRatio(100);
        options.setRated(false);
        options.setSpectatorsAllowed(false);
        options.setRollbackTurnsAllowed(false);
        options.setPassword(UUID.randomUUID().toString());
        options.getPlayerTypes().add(PlayerType.HUMAN);
        options.getPlayerTypes().add(PlayerType.HUMAN);
        options.championship = new ChampionshipRules(pairing, a, b, "playoffs".equals(command.get("stage").getAsString()),
                command.has("sideboardAfterGame") ? command.get("sideboardAfterGame").getAsInt() : 1, deadline(command));
        if (options.championship.playoffs && command.has("playDrawChooser") && !command.get("playDrawChooser").isJsonNull()) {
            String choice = command.get("playDrawChooser").getAsString();
            if (!(a.equalsIgnoreCase(choice) || b.equalsIgnoreCase(choice))) throw new IllegalArgumentException();
            options.championship.choosingSeat = choice;
        }
        Table table = managers.tableManager().createTable(managers.gamesRoomManager().getMainRoomId(), options);
        return managers.tableManager().getController(table.getId()).get();
    }

    private User online(String name) {
        return managers.userManager().getUserByName(name).filter(User::isConnected).orElse(null);
    }

    private static long deadline(JsonObject command) {
        return command.has("deadlineAt") && !command.get("deadlineAt").isJsonNull() ? command.get("deadlineAt").getAsLong() : 0;
    }
}
