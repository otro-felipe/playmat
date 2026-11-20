package mage.server.websocket.api;

import mage.cards.decks.DeckCardLists;
import mage.constants.TableState;
import mage.game.Table;
import mage.server.AuthorizedUserRepository;
import mage.server.User;
import mage.server.admin.RuntimeSettings;
import mage.server.career.CareerStore;
import mage.server.game.GamesRoom;
import mage.server.game.GameController;
import mage.server.playtesting.ProductGateway;
import mage.server.social.PlayerDirectory;
import mage.server.social.Presence;
import mage.server.social.PresenceStore;
import mage.server.social.SocialPlayers;
import mage.server.social.UserRelations;
import mage.server.websocket.rpc.RpcException;
import mage.server.websocket.rpc.RpcMethod;
import mage.server.websocket.service.OptionsMapper;
import mage.view.RoomUsersView;
import mage.view.TableView;

import java.sql.SQLException;
import java.util.Arrays;
import java.util.Collection;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.stream.Collectors;

import static mage.server.websocket.rpc.RpcParam.Type.INT;
import static mage.server.websocket.rpc.RpcParam.Type.STRING;
import static mage.server.websocket.rpc.RpcParam.Type.UUID;
import static mage.server.websocket.rpc.RpcParam.object;
import static mage.server.websocket.rpc.RpcParam.of;
import static mage.server.websocket.rpc.RpcParam.optional;

/**
 * Web client bridge: rooms, tables, seats, decks and chat.
 */
final class LobbyApi {

    /** What presenceGet and presenceSet answer. */
    public static class PresenceStatus {
        /** online, hidden or looking */
        public String status;

        PresenceStatus(String status) {
            this.status = status;
        }
    }

    private LobbyApi() {
    }

    private static String signedIn(ApiContext ctx, mage.server.websocket.rpc.RpcCall call) throws RpcException {
        return ctx.sessions.userName(call.sessionId()).orElseThrow(() -> RpcException.notAuthorized("Sign in first"));
    }

    /** The room's users as the caller may see them (Presence.visible): staff are looked up only when someone is hidden. */
    static List<RoomUsersView> roomUsers(ApiContext ctx, mage.server.websocket.rpc.RpcCall call) throws Exception {
        java.util.UUID roomId = call.uuid(0);
        List<RoomUsersView> rooms = ctx.managers == null
                ? ctx.server.roomGetUsers(roomId)
                : ctx.managers.gamesRoomManager().getRoom(roomId).map(GamesRoom::getRoomUsersInfo).orElse(Collections.emptyList());
        rooms = SocialPlayers.withoutAgents(rooms, ProductGateway.socialAgents());
        boolean anyHidden = rooms != null && rooms.stream().anyMatch(room -> room.getUsersView().stream()
                .anyMatch(user -> Presence.HIDDEN.equals(user.getStatus())));
        if (!anyHidden) {
            return rooms;
        }
        String viewer = ctx.sessions == null ? null : ctx.sessions.userName(call.sessionId()).orElse(null);
        return Presence.visibleRooms(rooms, viewer, Staff.member(ctx, call.sessionId()) != null);
    }

    private static Map<String, Integer> levels(Collection<String> names) {
        try {
            return CareerStore.get().levels(names);
        } catch (SQLException | RuntimeException e) {
            return Collections.emptyMap();
        }
    }

    static List<RpcMethod> methods(ApiContext ctx) {
        RpcMethod deckSubmit = RpcMethod.named("deckSubmit")
                .session(0)
                .params(of("sessionId", STRING), of("tableId", UUID), object("deck", "DeckCardLists"))
                .doc("Submit a deck for a table in construction or sideboarding.")
                .handler(call -> ctx.server.deckSubmit(call.string(0), call.uuid(1), call.object(2, DeckCardLists.class)));

        return Arrays.asList(
                RpcMethod.named("roomGetUsers")
                        .params(of("roomId", UUID))
                        .returns("RoomUsersView[]")
                        .doc("Users and server statistics of a room. Players who chose to appear offline (presenceSet) are left out, "
                                + "except the caller themselves and for staff; each user's status says online, looking (to play) or hidden. "
                                + "Private delegated agent identities are excluded from human social discovery.")
                        .handler(call -> roomUsers(ctx, call)),

                RpcMethod.named("presenceGet")
                        .returns("PresenceStatus")
                        .doc("The status the signed-in player chose: online, hidden (appear offline) or looking (to play).")
                        .handler(call -> {
                            String userName = signedIn(ctx, call);
                            return new PresenceStatus(Presence.statusOf(userName));
                        }),

                RpcMethod.named("presenceSet")
                        .params(of("status", STRING))
                        .returns("PresenceStatus")
                        .doc("Choose how the signed-in player shows to others, until they change it again (it lasts across sessions): "
                                + "online, hidden (left out of the online list, so friends see them offline; whispers only from players "
                                + "they whispered first) or looking (to play, shown beside the name).")
                        .handler(call -> {
                            String userName = signedIn(ctx, call);
                            String status = call.string(0);
                            if (!Presence.known(status)) {
                                throw RpcException.invalidParams("The status is online, hidden or looking");
                            }
                            PresenceStore store = PresenceStore.get();
                            if (store == null) {
                                throw new RpcException(RpcException.SERVER_ERROR, "The status can't be stored on this server right now");
                            }
                            try {
                                store.set(userName, status, System.currentTimeMillis());
                            } catch (SQLException e) {
                                throw new RpcException(RpcException.SERVER_ERROR, "The status can't be stored on this server right now", e);
                            }
                            return new PresenceStatus(store.status(userName));
                        }),

                RpcMethod.named("playerDirectory")
                        .params(optional("query", STRING), optional("offset", INT))
                        .returns("DirectoryPage")
                        .doc("The server's registered players, " + PlayerDirectory.PAGE_SIZE + " at a time, by name: each one's name, Career "
                                + "level (when Career is on) and whether they are online (hidden players show offline, except to staff). "
                                + "query matches names only. enabled is false when staff turned the directory off or the server has no accounts. "
                                + "Private delegated agent identities are excluded before counting and pagination.")
                        .handler(call -> {
                            String viewer = signedIn(ctx, call);
                            if (ctx.managers == null || !ctx.managers.configSettings().isAuthenticationActivated()
                                    || !RuntimeSettings.get().directoryOn()) {
                                return PlayerDirectory.disabled();
                            }
                            boolean staff = Staff.member(ctx, call.sessionId()) != null;
                            return PlayerDirectory.page(AuthorizedUserRepository.getInstance(), call.optString(0, ""), call.optInteger(1, 0),
                                    viewer, staff,
                                    name -> ctx.managers.userManager().getUserByName(name).map(User::isOnlineUser).orElse(false),
                                    CareerApi.enabled(ctx) ? LobbyApi::levels : null, ProductGateway.socialAgents());
                        }),

                RpcMethod.named("roomGetAllTables")
                        .params(of("roomId", UUID))
                        .returns("TableView[]")
                        .doc("All open and running tables of a room.")
                        .handler(call -> {
                            List<TableView> tables = ctx.server.roomGetAllTables(call.uuid(0));
                            if (!ProductGateway.enabled()) {
                                return tables;
                            }
                            String viewer = signedIn(ctx, call);
                            Set<java.util.UUID> invitations = ProductGateway.visibleInvitations(viewer);
                            return tables.stream().filter(table -> visibleToSeat(table, viewer, invitations)).collect(Collectors.toList());
                        }),

                RpcMethod.named("roomGetTableById")
                        .params(of("roomId", UUID), of("tableId", UUID))
                        .returns("TableView | null")
                        .doc("One table of a room. An eligible player with an unlisted invitation may view its waiting table by ID.")
                        .handler(call -> {
                            TableView table = ctx.server.roomGetTableById(call.uuid(0), call.uuid(1));
                            if (!ProductGateway.enabled() || table == null) {
                                return table;
                            }
                            String viewer = signedIn(ctx, call);
                            if (visibleToSeat(table, viewer, ProductGateway.visibleInvitations(viewer))) {
                                return table;
                            }
                            return table.getTableState() == TableState.WAITING
                                    && ProductGateway.canViewByLink(table.getTableId(), table.getControllerName(), viewer) ? table : null;
                        }),

                RpcMethod.named("roomGetFinishedMatches")
                        .params(of("roomId", UUID))
                        .returns("MatchView[]")
                        .doc("Recently finished matches of a room.")
                        .handler(call -> ProductGateway.enabled() ? Collections.emptyList() : ctx.server.roomGetFinishedMatches(call.uuid(0))),

                RpcMethod.named("roomCreateTable")
                        .session(0)
                        .params(of("sessionId", STRING), of("roomId", UUID), object("options", "WebMatchOptions"))
                        .returns("TableView")
                        .doc("Create a match table. The creator still has to join a seat.")
                        .handler(call -> ctx.server.roomCreateTable(call.string(0), call.uuid(1),
                                OptionsMapper.toMatchOptions(call.jsonObject(2)))),

                RpcMethod.named("roomJoinTable")
                        .session(0)
                        .params(of("sessionId", STRING), of("roomId", UUID), of("tableId", UUID), of("name", STRING),
                                of("playerType", STRING), of("skill", INT), object("deck", "DeckCardLists"), optional("password", STRING))
                        .doc("Take a seat at a table (yourself or an AI player).")
                        .handler(call -> ctx.server.roomJoinTable(call.string(0), call.uuid(1), call.uuid(2), call.string(3),
                                OptionsMapper.toPlayerType(call.string(4)), call.integer(5),
                                call.object(6, DeckCardLists.class), call.optString(7, ""))),

                RpcMethod.named("roomLeaveTableOrTournament")
                        .session(0)
                        .params(of("sessionId", STRING), of("roomId", UUID), of("tableId", UUID))
                        .doc("Leave a table or tournament before it starts.")
                        .handler(call -> ctx.server.roomLeaveTableOrTournament(call.string(0), call.uuid(1), call.uuid(2))),

                RpcMethod.named("roomWatchTable")
                        .session(0)
                        .params(of("sessionId", STRING), of("roomId", UUID), of("tableId", UUID))
                        .doc("Spectate a running match.")
                        .handler(call -> {
                            if (ProductGateway.enabled()) {
                                throw RpcException.notAuthorized("Private practice matches cannot be spectated");
                            }
                            return ctx.server.roomWatchTable(call.string(0), call.uuid(1), call.uuid(2));
                        }),

                RpcMethod.named("matchStart")
                        .session(0)
                        .params(of("sessionId", STRING), of("roomId", UUID), of("tableId", UUID))
                        .doc("Start a match once all seats are filled (table owner only).")
                        .handler(call -> ctx.server.matchStart(call.string(0), call.uuid(1), call.uuid(2))),

                RpcMethod.named("tableSwapSeats")
                        .session(0)
                        .params(of("sessionId", STRING), of("roomId", UUID), of("tableId", UUID), of("seatNum1", INT), of("seatNum2", INT))
                        .doc("Reorder seats (table owner only).")
                        .handler(call -> {
                            ctx.server.tableSwapSeats(call.string(0), call.uuid(1), call.uuid(2), call.integer(3), call.integer(4));
                            return true;
                        }),

                RpcMethod.named("tableRemove")
                        .session(0)
                        .params(of("sessionId", STRING), of("roomId", UUID), of("tableId", UUID))
                        .doc("Remove a table (table owner only).")
                        .handler(call -> {
                            ctx.server.tableRemove(call.string(0), call.uuid(1), call.uuid(2));
                            return true;
                        }),

                RpcMethod.named("tableIsOwner")
                        .session(0)
                        .params(of("sessionId", STRING), of("roomId", UUID), of("tableId", UUID))
                        .doc("Whether the caller owns the table.")
                        .handler(call -> ctx.server.tableIsOwner(call.string(0), call.uuid(1), call.uuid(2))),

                deckSubmit,
                deckSubmit.alias("submitDeck"),

                RpcMethod.named("deckSave")
                        .session(0)
                        .params(of("sessionId", STRING), of("tableId", UUID), object("deck", "DeckCardLists"))
                        .doc("Save the in-progress limited deck without submitting it.")
                        .handler(call -> {
                            ctx.server.deckSave(call.string(0), call.uuid(1), call.object(2, DeckCardLists.class));
                            return true;
                        }),

                RpcMethod.named("chatJoin")
                        .session(1)
                        .params(of("chatId", UUID), of("sessionId", STRING), optional("userName", STRING))
                        .doc("Subscribe to a chat.")
                        .handler(call -> {
                            if (ProductGateway.enabled() && !canJoinPrivateChat(ctx, call.sessionId(), call.uuid(0))) {
                                throw RpcException.notAuthorized("Only the participants can join that chat");
                            }
                            ctx.server.chatJoin(call.uuid(0), call.string(1), call.optString(2, ""));
                            return true;
                        }),

                RpcMethod.named("chatLeave")
                        .session(1)
                        .params(of("chatId", UUID), of("sessionId", STRING))
                        .doc("Unsubscribe from a chat.")
                        .handler(call -> {
                            ctx.server.chatLeave(call.uuid(0), call.string(1));
                            return true;
                        }),

                RpcMethod.named("chatSendMessage")
                        .params(of("chatId", UUID), optional("userName", STRING), of("message", STRING))
                        .doc("Post to a chat as the logged in user, who must have joined it (chatJoin; the lobby chat is joined on login). "
                                + "userName is ignored; the session decides the author.")
                        .handler(call -> {
                            String userName = ctx.sessions.userName(call.sessionId())
                                    .orElseThrow(() -> RpcException.notAuthorized("Log in before chatting"));
                            if (!ctx.sessions.isChatMember(call.sessionId(), call.uuid(0))) {
                                throw RpcException.notAuthorized("Join the chat before posting to it");
                            }
                            ctx.server.chatSendMessage(call.uuid(0), userName, call.string(2));
                            return true;
                        }),

                RpcMethod.named("chatSetIgnored")
                        .params(object("names", "string[]"))
                        .doc("Players this user ignores, by name, for as long as the session lasts (the client keeps the list and "
                                + "sends it after each login): their table chat doesn't reach the user and their whispers are refused. "
                                + "At most " + UserRelations.MAX_IGNORED + " names; an empty list clears it.")
                        .handler(call -> {
                            String userName = ctx.sessions.userName(call.sessionId())
                                    .orElseThrow(() -> RpcException.notAuthorized("Log in before setting who you ignore"));
                            User user = ctx.managers.userManager().getUserByName(userName)
                                    .orElseThrow(() -> RpcException.notAuthorized("Log in before setting who you ignore"));
                            String[] names = call.object(0, String[].class);
                            UserRelations.setIgnored(user.getId(), names == null ? Collections.emptyList() : Arrays.asList(names));
                            return true;
                        }),

                RpcMethod.named("chatFindByGame")
                        .params(of("gameId", UUID))
                        .returns("UUID | null")
                        .doc("Chat of a game.")
                        .handler(call -> ctx.server.chatFindByGame(call.uuid(0))),

                RpcMethod.named("chatFindByTable")
                        .params(of("tableId", UUID))
                        .returns("UUID | null")
                        .doc("Chat of a table.")
                        .handler(call -> ctx.server.chatFindByTable(call.uuid(0))),

                RpcMethod.named("chatFindByTournament")
                        .params(of("tournamentId", UUID))
                        .returns("UUID | null")
                        .doc("Chat of a tournament.")
                        .handler(call -> ctx.server.chatFindByTournament(call.uuid(0))),

                RpcMethod.named("chatFindByRoom")
                        .params(of("roomId", UUID))
                        .returns("UUID | null")
                        .doc("Chat of a room.")
                        .handler(call -> ctx.server.chatFindByRoom(call.uuid(0)))
        );
    }

    private static boolean visibleToSeat(TableView table, String viewer, Set<java.util.UUID> invitations) {
        return viewer.equalsIgnoreCase(table.getControllerName())
                || table.getSeats().stream().anyMatch(seat -> viewer.equalsIgnoreCase(seat.getPlayerName()))
                || invitations.contains(table.getTableId());
    }

    private static boolean canJoinPrivateChat(ApiContext ctx, String sessionId, java.util.UUID chatId) {
        String user = ctx.sessions.userName(sessionId).orElse("");
        if (user.isEmpty()) {
            return false;
        }
        if (ctx.managers.chatManager().getChatSessions().stream()
                .anyMatch(chat -> chatId.equals(chat.getChatId()) && chat.isRoomChat())) {
            return true;
        }
        GameController game = ctx.managers.gameManager().getGameController().values().stream()
                .filter(controller -> chatId.equals(controller.getChatId())).findFirst().orElse(null);
        Table table = game == null
                ? ctx.managers.tableManager().getTables().stream()
                    .filter(candidate -> ctx.managers.tableManager().getChatId(candidate.getId())
                            .filter(chatId::equals).isPresent())
                    .findFirst().orElse(null)
                : ctx.managers.tableManager().getTable(game.getTableId());
        return table != null && (user.equalsIgnoreCase(table.getControllerName())
                || Arrays.stream(table.getSeats()).anyMatch(seat -> seat.getPlayer() != null
                        && user.equalsIgnoreCase(seat.getPlayer().getName())));
    }
}
