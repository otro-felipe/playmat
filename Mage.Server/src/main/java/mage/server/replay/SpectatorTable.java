package mage.server.replay;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;
import mage.game.Table;
import mage.view.ChatMessage;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;

/** An outbound projection. It has no session, player commands, private replay evidence or chat membership. */
public final class SpectatorTable {
    private static final int RECENT_EVENTS = 100;
    private static final int FINISHED_TABLES = 64;
    private static final Map<UUID, SpectatorTable> active = new LinkedHashMap<>();
    private static final Map<UUID, SpectatorTable> finished = new LinkedHashMap<>();
    private final UUID tableId, gameId;
    private final String owner;
    private final JsonArray lines = new JsonArray(), chat = new JsonArray();
    private JsonObject view, hands = new JsonObject(), names = new JsonObject();
    private long revision;
    private boolean ended;
    private JsonObject seatKnowledge = new JsonObject();

    SpectatorTable(UUID tableId, UUID gameId, String owner) {
        this.tableId = tableId;
        this.gameId = gameId;
        this.owner = owner;
    }

    static synchronized SpectatorTable start(Table table, UUID game) {
        if (table == null || table.getControllerName() == null) return null;
        SpectatorTable state = new SpectatorTable(table.getId(), game, table.getControllerName());
        active.put(table.getId(), state);
        finished.remove(table.getId());
        return state;
    }

    synchronized void frame(JsonObject publicView, JsonObject cardsInHand, JsonObject playerNames) {
        frame(publicView, cardsInHand, playerNames, new JsonObject());
    }

    synchronized void frame(JsonObject publicView, JsonObject cardsInHand, JsonObject playerNames, JsonObject knowledge) {
        seatKnowledge = knowledge;
        view = publicView;
        hands = cardsInHand;
        names = playerNames;
        revision++;
    }

    synchronized void line(UUID player, String command, LineExplanation explanation, int turn, long at) {
        if (!names.has(player.toString())) return;
        JsonObject row = new JsonObject();
        row.addProperty("lineId", gameId + ":" + player + ":" + command);
        row.addProperty("playerId", player.toString());
        row.add("playerName", names.get(player.toString()));
        explanation.writeTo(row);
        row.addProperty("at", at);
        row.addProperty("turn", turn);
        append(lines, row);
    }

    synchronized JsonObject chat(ChatMessage source) {
        if (source.getMessageType() != ChatMessage.MessageType.TALK || source.getUsername() == null
                || source.getMessage() == null || !names.entrySet().stream().anyMatch(p -> p.getValue().getAsString().equals(source.getUsername()))) return null;
        JsonObject item = new JsonObject();
        item.addProperty("messageId", gameId + ":" + (source.getChatSequence() == null ? "event-" + (revision + 1) : source.getChatSequence()));
        item.addProperty("playerName", source.getUsername());
        item.addProperty("type", "TALK");
        item.addProperty("message", org.unbescape.html.HtmlEscape.unescapeHtml(source.getMessage()));
        item.addProperty("at", source.getTime() == null ? System.currentTimeMillis() : source.getTime().getTime());
        append(chat, item);
        return item;
    }

    private void append(JsonArray buffer, JsonObject row) {
        if (buffer.size() >= RECENT_EVENTS) buffer.remove(0);
        buffer.add(row);
        revision++;
    }

    static synchronized void end(SpectatorTable state) {
        if (state == null || !active.remove(state.tableId, state)) return;
        synchronized (state) { state.ended = true; state.seatKnowledge = new JsonObject(); state.revision++; }
        finished.put(state.tableId, state);
        if (finished.size() > FINISHED_TABLES) finished.remove(finished.keySet().iterator().next());
    }

    /** Internal product response. The owner is read from the table created by XMage, never from the client. */
    public static synchronized JsonObject lookup(UUID id, Table table) {
        return lookup(id, table, false);
    }

    public static synchronized JsonObject lookup(UUID id, Table table, boolean includeSeatKnowledge) {
        SpectatorTable state = active.get(id);
        if (state == null) state = finished.get(id);
        if (state == null && table == null) return null;
        if (state == null) state = new SpectatorTable(id, null, table.getControllerName());
        JsonObject response = new JsonObject();
        response.addProperty("owner", state.owner);
        JsonObject snapshot = state.snapshot(includeSeatKnowledge);
        if (state.ended && table != null && table.getState() != mage.constants.TableState.FINISHED
                && table.getMatch() != null && table.getMatch().getEndTime() == null) {
            snapshot.addProperty("status", "between_games");
        }
        response.add("snapshot", snapshot);
        return response;
    }

    synchronized JsonObject snapshot() {
        return snapshot(false);
    }

    synchronized JsonObject snapshot(boolean includeSeatKnowledge) {
        JsonObject result = new JsonObject();
        result.addProperty("role", "spectator");
        result.addProperty("tableId", tableId.toString());
        result.add("gameId", gameId == null ? JsonNull.INSTANCE : new com.google.gson.JsonPrimitive(gameId.toString()));
        result.addProperty("status", ended ? "finished" : view == null ? "waiting" : "playing");
        result.addProperty("revision", revision);
        JsonArray players = new JsonArray();
        for (Map.Entry<String,JsonElement> p : names.entrySet()) {
            JsonObject player = new JsonObject();
            player.addProperty("playerId",p.getKey());
            player.add("name",p.getValue());
            players.add(player);
        }
        result.add("players", players);
        result.add("view", view == null ? JsonNull.INSTANCE : view);
        result.add("hands", hands);
        if (includeSeatKnowledge && !ended) result.add("seatKnowledge", seatKnowledge);
        result.add("lines", lines.deepCopy());
        result.add("chat", chat.deepCopy());
        return result;
    }
}
