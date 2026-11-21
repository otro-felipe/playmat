package mage.server.websocket;

import mage.server.websocket.rpc.RpcConnection.PromptCommit;
import mage.server.websocket.rpc.RpcException;

import mage.interfaces.callback.ClientCallback;
import mage.interfaces.callback.ClientCallbackMethod;
import mage.server.ClientChannel;
import mage.view.AbilityPickerView;
import mage.view.GameClientMessage;
import mage.view.GameView;
import mage.view.TableClientMessage;

import java.util.HashMap;
import java.util.LinkedHashSet;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

/** One engine session and prompt owner for the account's browser and its table-scoped transports. */
final class HumanSeatChannel implements ClientChannel {
    private final Set<ConnectionState> members = new LinkedHashSet<>();
    private final Map<UUID, ClientCallback> starts = new HashMap<>();
    private final Map<UUID, ClientCallback> views = new HashMap<>();
    private final Map<UUID, ClientCallback> prompts = new HashMap<>();
    private final Map<UUID, ClientCallback> sideboards = new HashMap<>();
    final String name;
    String sessionId;

    HumanSeatChannel(String name) { this.name = name; }

    synchronized boolean hasDelegate() {
        return members.stream().anyMatch(state -> state.getHumanTable() != null);
    }

    synchronized void attach(ConnectionState state) {
        members.add(state);
        state.attach(this);
    }

    synchronized boolean detach(ConnectionState state) {
        members.remove(state);
        return members.isEmpty();
    }

    synchronized void replaceBrowser(ConnectionState current) {
        for (ConnectionState old : new LinkedHashSet<>(members)) {
            if (old != current && old.getHumanTable() == null) {
                members.remove(old);
                old.bindSession(null);
                old.replaced();
            }
        }
    }

    @Override public synchronized boolean hostsGames() {
        return members.stream().anyMatch(state -> state.getHumanTable() == null && state.browserHostsGames());
    }

    @Override public synchronized String gameHostId() {
        return members.stream().filter(state -> state.getHumanTable() == null && state.browserHostsGames())
                .map(ConnectionState::browserHostId).filter(java.util.Objects::nonNull).findFirst().orElse(null);
    }

    /** Reattach only this transport. Never restart the game or answer an engine prompt to obtain a refresh. */
    synchronized void replay(ConnectionState state) throws Closed {
        for (ClientCallback start : starts.values()) {
            if (!state.deliver(start)) continue;
            UUID game = start.getObjectId();
            if (views.containsKey(game)) state.deliver(views.get(game));
            if (prompts.containsKey(game)) state.deliver(prompts.get(game));
        }
        for (ClientCallback sideboard : sideboards.values()) state.deliver(sideboard);
    }

    synchronized boolean rejoinBrowser(ConnectionState state, UUID game) {
        if (!hasDelegate() || !views.containsKey(game)) return false;
        try {
            state.deliver(views.get(game));
            if (prompts.containsKey(game)) state.deliver(prompts.get(game));
            return true;
        } catch (Closed ignored) {
            return false;
        }
    }

    synchronized boolean resendPrompt(ConnectionState state, UUID game) {
        ClientCallback prompt = prompts.get(game);
        try { return prompt != null && state.deliver(prompt); }
        catch (Closed ignored) { return false; }
    }

    synchronized boolean takePrompt(UUID game, Integer id, PromptCommit commit) throws RpcException {
        ClientCallback current = prompts.get(game);
        if (current == null && (id != null || hasDelegate())) return false;
        if (id != null && current.getMessageId() != id) return false;
        commit.run();
        answered(game);
        return true;
    }

    synchronized void answered(UUID game) {
        prompts.remove(game);
        for (ConnectionState state : members) state.forgetLocalPrompt(game);
    }

    private static ClientCallback copy(ClientCallback source, ClientCallbackMethod method, Object data) {
        ClientCallback copy = new ClientCallback(method, source.getObjectId(), data);
        copy.setMessageId(source.getMessageId());
        return copy;
    }

    private void remember(ClientCallback event) {
        UUID id = event.getObjectId();
        if (id == null) return;
        ClientCallbackMethod method = event.getMethod();
        Object data = event.getData();
        if (method == ClientCallbackMethod.START_GAME && data instanceof TableClientMessage) {
            starts.put(id, copy(event, method, data));
            sideboards.remove(((TableClientMessage)data).getCurrentTableId());
        } else if (method == ClientCallbackMethod.SIDEBOARD && data instanceof TableClientMessage) {
            sideboards.put(id, copy(event, method, data));
        } else if (method == ClientCallbackMethod.GAME_OVER) {
            starts.remove(id);
            views.remove(id);
            prompts.remove(id);
        } else if (method == ClientCallbackMethod.GAME_ROLLBACK) {
            prompts.remove(id);
            views.remove(id);
        } else if (starts.containsKey(id)) {
            if (WebSocketCallbackHandler.isPrompt(method)) prompts.put(id, copy(event, method, data));
            GameView view = data instanceof GameView ? (GameView)data : data instanceof GameClientMessage
                    ? ((GameClientMessage)data).getGameView() : data instanceof AbilityPickerView ? ((AbilityPickerView)data).getGameView() : null;
            if (view != null) views.put(id, copy(event, ClientCallbackMethod.GAME_UPDATE, view));
        }
    }

    @Override public synchronized void send(ClientCallback callback) throws Closed {
        callback.decompressData();
        remember(callback);
        boolean reachable = false;
        for (ConnectionState state : members) {
            if (!state.isOpen()) continue;
            try {
                state.deliver(callback);
                reachable = true; // filtered callbacks on an open scoped socket are expected
            } catch (Closed lostMember) {
                // Other transports can still be attached to this engine session.
            }
        }
        if (!reachable) throw new Closed("The human seat has no connected transport");
    }
}
