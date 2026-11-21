package mage.server.websocket;

import com.google.gson.JsonArray;
import mage.game.Table;
import mage.server.game.GameController;
import mage.server.managers.ManagerFactory;
import mage.server.playtesting.ProductGateway;
import mage.server.recovery.RecoveryPrincipal;
import mage.server.websocket.rpc.RpcException;
import mage.server.websocket.rpc.RpcMethod;
import mage.server.websocket.rpc.RpcParam;

import java.util.UUID;
import java.util.function.Function;
import java.util.function.Predicate;

/** Browser control follows the durable seat setting even when no agent is online. */
final class HumanBrowserControl {
    private final Function<UUID, UUID> gameTable, chatTable;
    private final Predicate<UUID> mayPlay;

    HumanBrowserControl(Function<UUID, UUID> gameTable, Function<UUID, UUID> chatTable, Predicate<UUID> mayPlay) {
        this.gameTable = gameTable;
        this.chatTable = chatTable;
        this.mayPlay = mayPlay;
    }

    static HumanBrowserControl forSeat(ManagerFactory managers, RecoveryPrincipal principal) {
        return new HumanBrowserControl(id -> {
            GameController game = managers.gameManager().getGameController().get(id);
            return game == null ? null : game.getTableId();
        }, id -> {
            for (GameController game : managers.gameManager().getGameController().values()) {
                if (id.equals(game.getChatId())) return game.getTableId();
            }
            for (Table table : managers.tableManager().getTables()) {
                if (managers.tableManager().getChatId(table.getId()).filter(id::equals).isPresent()) return table.getId();
            }
            return null; // lobby and social chats are independent of any match
        }, id -> ProductGateway.humanBrowserMayPlay(principal, id));
    }

    void check(RpcMethod method, JsonArray params) throws RpcException {
        if (method == null) return;
        String name = method.getAliasOf() == null ? method.getName() : method.getAliasOf();
        switch (name) {
            case "gameJoin": case "gameResync": case "gameStateResync": case "gameWatchers":
            case "gameWatchStart": case "gameWatchStop": case "chatJoin": case "chatFindByGame":
            case "chatFindByTable": case "roomGetTableById": case "tableIsOwner": case "roomWatchTable":
            case "roomJoinTable": case "matchStart": case "careerQuestTracker": case "reportPlayer":
            case "soloTurns": case "replayPage": case "replayInit": case "replayStart": case "replayStop":
            case "replayNext": case "replayPrevious": case "replaySkipForward":
                return;
            default:
                // Mutations (including newly added RPCs) use the scope declared by their parameter.
                // The dispatcher still performs session and argument checks before invoking the handler.
        }
        int index = 0;
        for (RpcParam parameter : method.getParams()) {
            String key = parameter.getName();
            if ((key.equals("gameId") || key.equals("tableId") || key.equals("chatId")) && index < params.size()) {
                UUID id;
                try {
                    id = UUID.fromString(params.get(index).getAsString());
                } catch (RuntimeException malformed) {
                    throw RpcException.invalidParams("Invalid " + key);
                }
                UUID table = key.equals("gameId") ? gameTable.apply(id) : key.equals("chatId") ? chatTable.apply(id) : id;
                if (table != null && !mayPlay.test(table)) throw readOnly();
            }
            index++;
        }
    }

    static RpcException readOnly() {
        return RpcException.notAuthorized("MCP al mando · solo lectura");
    }
}
