package mage.server.websocket;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import mage.interfaces.callback.ClientCallback;
import mage.server.recovery.RecoveryPrincipal;
import mage.server.websocket.rpc.RpcException;
import mage.view.TableClientMessage;
import mage.view.TableView;
import mage.view.UserRequestMessage;

import java.util.UUID;
import java.util.function.Predicate;

/** A delegated socket is bound once, either to an authorized table or to the table it creates. */
final class HumanTableScope {
    private final Predicate<UUID> authorized;
    private final boolean creator;
    private final boolean startOnly;
    private volatile UUID table;
    private volatile UUID game;
    private volatile UUID chat;
    private volatile boolean play;
    private volatile boolean started;

    HumanTableScope(String requested, Predicate<UUID> authorized) {
        this.authorized = authorized;
        creator = "create".equals(requested);
        startOnly = requested.startsWith("start:");
        table = creator ? null : UUID.fromString(startOnly ? requested.substring(6) : requested);
        play = !creator && !startOnly;
    }

    static boolean validHeader(String value, boolean loopback, RecoveryPrincipal principal) {
        if (!loopback || principal == null || principal.connectionId == null
                || !principal.seatId.equals("human:" + principal.accountId)) return false;
        if ("create".equals(value)) return true;
        if (value == null) return false;
        String raw = value.startsWith("start:") ? value.substring(6) : value;
        UUID id = uuid(raw);
        return id != null && id.toString().equalsIgnoreCase(raw);
    }

    String header() { return table == null ? "create" : (startOnly ? "start:" : "") + table; }

    private static UUID uuid(String text) {
        try { return UUID.fromString(text); } catch (IllegalArgumentException | NullPointerException ignored) { return null; }
    }

    private static String text(JsonArray params, int index) {
        return params.size() > index && params.get(index).isJsonPrimitive() ? params.get(index).getAsString() : "";
    }

    private boolean table(JsonArray params, int index) {
        UUID bound = table;
        return bound != null && bound.equals(uuid(text(params, index)));
    }

    private boolean game(JsonArray params, int index) {
        UUID bound = game;
        return play && bound != null && bound.equals(uuid(text(params, index)));
    }

    void check(String method, JsonArray params) throws RpcException {
        boolean permitted;
        boolean grantOnly = false;
        switch (method) {
            case "connectUser": case "ping": case "serverGetMainRoomId": case "setCapabilities":
                permitted = true;
                grantOnly = creator && !play;
                break;
            case "roomCreateTable": case "deckValidate":
                permitted = creator && table == null;
                grantOnly = true;
                break;
            case "roomJoinTable": case "tableRemove":
                permitted = creator && !started && table(params, 2);
                grantOnly = true;
                break;
            case "tableIsOwner": case "matchStart":
                permitted = table(params, 2) && (play || (creator || startOnly) && !started);
                grantOnly = creator && !play;
                break;
            case "roomGetTableById":
                permitted = !startOnly && table(params, 1);
                grantOnly = creator && !play && !started;
                break;
            case "recoveryList": case "recoveryStatus": case "recoveryJoin":
                permitted = play && table != null; // RecoveryApi resolves each checkpoint against this table.
                break;
            case "deckSubmit":
                permitted = play && table(params, 1);
                break;
            case "chatJoin": case "chatSendMessage":
                permitted = play && chat != null && chat.equals(uuid(text(params, 0)));
                break;
            case "gameJoin": case "gameResync": case "matchQuit": case "chatFindByGame":
                permitted = game(params, 0);
                break;
            case "sendPlayerUUID": case "sendPlayerBoolean": case "sendPlayerString": case "sendPlayerInteger":
                permitted = game(params, 0) && params.size() > 3 && params.get(3).isJsonPrimitive();
                break;
            case "sendPlayerManaType":
                permitted = game(params, 0) && params.size() > 4 && params.get(4).isJsonPrimitive();
                break;
            case "sendPlayerAction":
                String action = text(params, 0);
                permitted = game(params, 1) && ("CONCEDE".equals(action) || "ROLLBACK_TURNS".equals(action)
                        || "ADD_PERMISSION_TO_ROLLBACK_TURN".equals(action) || "DENY_PERMISSION_TO_ROLLBACK_TURN".equals(action));
                break;
            default: permitted = false;
        }
        if (!permitted || !authorized.test(grantOnly ? null : table)) {
            throw RpcException.notAuthorized("This operation is unavailable for the delegated table");
        }
    }

    void after(String method, JsonArray params, Object result) {
        if ("roomCreateTable".equals(method) && result instanceof TableView) {
            JsonElement allowed = params.get(2).getAsJsonObject().get("humanMcpAllowed");
            created(((TableView)result).getTableId(), allowed != null && allowed.getAsBoolean());
        } else if ("chatFindByGame".equals(method) && result instanceof UUID) {
            rememberChat(uuid(text(params, 0)), (UUID)result);
        } else if ("matchStart".equals(method) && Boolean.TRUE.equals(result)) {
            started = true;
        }
    }

    void created(UUID id, boolean allowed) {
        if (!creator || table != null) throw new IllegalStateException("A delegated socket creates one table");
        play = allowed;
        table = id;
    }

    private synchronized void rememberChat(UUID requestedGame, UUID found) {
        if (requestedGame != null && requestedGame.equals(game)) chat = found;
    }

    private synchronized void startGame(UUID nextGame) {
        if (!nextGame.equals(game)) chat = null;
        game = nextGame;
        started = true;
    }

    boolean accept(ClientCallback message) {
        UUID bound = table;
        if (!play || bound == null) return false;
        UUID subject = message.getObjectId();
        switch (message.getMethod()) {
            case JOINED_TABLE: case SIDEBOARD: case START_GAME:
                if (!(message.getData() instanceof TableClientMessage)) return false;
                TableClientMessage data = (TableClientMessage)message.getData();
                if (!bound.equals(data.getCurrentTableId()) || !authorized.test(bound)) return false;
                if (message.getMethod() == mage.interfaces.callback.ClientCallbackMethod.START_GAME) {
                    if (subject == null || !subject.equals(data.getGameId()) || data.getPlayerId() == null) return false;
                    startGame(subject);
                }
                return true;
            case CHATMESSAGE: return chat != null && chat.equals(subject) && authorized.test(bound);
            case USER_REQUEST_DIALOG:
                return game != null && message.getData() instanceof UserRequestMessage
                        && game.equals(((UserRequestMessage)message.getData()).getGameId())
                        && ((UserRequestMessage)message.getData()).getButton1Action() == mage.constants.PlayerAction.ADD_PERMISSION_TO_ROLLBACK_TURN
                        && authorized.test(bound);
            case GAME_INIT: case GAME_UPDATE: case GAME_UPDATE_AND_INFORM: case GAME_INFORM_PERSONAL:
            case GAME_ASK: case GAME_SELECT: case GAME_TARGET: case GAME_CHOOSE_ABILITY: case GAME_CHOOSE_PILE:
            case GAME_CHOOSE_CHOICE: case GAME_PLAY_MANA: case GAME_PLAY_XMANA: case GAME_GET_AMOUNT:
            case GAME_GET_MULTI_AMOUNT: case GAME_ROLLBACK: case GAME_ERROR: case GAME_OVER: case END_GAME_INFO:
                return game != null && game.equals(subject) && authorized.test(bound);
            default: return false;
        }
    }
}
