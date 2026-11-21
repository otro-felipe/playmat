package mage.server.websocket;

import mage.interfaces.callback.ClientCallback;
import mage.interfaces.callback.ClientCallbackMethod;
import mage.view.TableClientMessage;
import org.java_websocket.WebSocket;
import org.junit.jupiter.api.Test;

import java.lang.reflect.Proxy;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static mage.server.websocket.rpc.RpcConnection.PromptCommit.NONE;
import mage.server.websocket.rpc.RpcException;

class HumanSeatChannelTest {
    private ConnectionState endpoint(List<String> frames) {
        WebSocket socket = (WebSocket) Proxy.newProxyInstance(WebSocket.class.getClassLoader(), new Class<?>[]{WebSocket.class},
                (proxy, method, args) -> {
                    if ("isOpen".equals(method.getName())) return true;
                    if ("send".equals(method.getName())) frames.add((String)args[0]);
                    return null;
                });
        return new ConnectionState(socket, Runnable::run, "127.0.0.1", 0);
    }

    private ClientCallback start(UUID table, UUID game) {
        return new ClientCallback(ClientCallbackMethod.START_GAME, game,
                new TableClientMessage().withTable(table, null).withGame(game).withPlayer(UUID.randomUUID()));
    }

    @Test void closingASetupOnlySocketPreservesTheExistingBrowserLogin() throws Exception {
        java.util.Set<String> active = new java.util.HashSet<>();
        mage.server.websocket.rpc.RpcSessions sessions = (mage.server.websocket.rpc.RpcSessions)Proxy.newProxyInstance(
                getClass().getClassLoader(), new Class<?>[]{mage.server.websocket.rpc.RpcSessions.class}, (proxy, method, args) -> {
                    switch (method.getName()) {
                        case "create": active.add((String)args[0]); return null;
                        case "exists": return active.contains(args[0]);
                        default: throw new AssertionError("Unexpected session operation " + method.getName());
                    }
                });
        HumanSeatSessions registry = new HumanSeatSessions(sessions);
        mage.server.websocket.rpc.RpcDispatcher dispatcher = new mage.server.websocket.rpc.RpcDispatcher(sessions);
        dispatcher.register(mage.server.websocket.rpc.RpcMethod.named("connectUser").establishes(1)
                .params(mage.server.websocket.rpc.RpcParam.of("userName", mage.server.websocket.rpc.RpcParam.Type.STRING),
                        mage.server.websocket.rpc.RpcParam.optional("session", mage.server.websocket.rpc.RpcParam.Type.STRING))
                .handler(call -> { call.getConnection().setUserName(call.string(0)); return true; }));
        UUID account = UUID.randomUUID();
        ConnectionState browser = endpoint(new ArrayList<>()), setup = endpoint(new ArrayList<>());
        browser.setSignedOnUser("Alice");
        setup.setSignedOnUser("Alice");
        browser.setRecoveryPrincipal(new mage.server.recovery.RecoveryPrincipal(account, "human:" + account));
        setup.setRecoveryPrincipal(new mage.server.recovery.RecoveryPrincipal(account, "human:" + account, UUID.randomUUID()));
        setup.setHumanScope(new HumanTableScope("start:" + UUID.randomUUID(), id -> true));
        com.google.gson.JsonArray params = new com.google.gson.JsonArray();
        params.add("Alice");
        assertThat(registry.login(browser, params, dispatcher)).isEqualTo(true);
        assertThat(registry.login(setup, params, dispatcher)).isEqualTo(true);
        assertThat(active).containsExactly(browser.getSessionId());
        assertThat(setup.getSessionId()).isEqualTo(browser.getSessionId());
        assertThat(registry.leave(setup)).isTrue();
        assertThat(setup.getSessionId()).isNull();
        assertThat(browser.isOpen()).isTrue();
        assertThat(active).containsExactly(browser.getSessionId());
        assertThat(registry.leave(browser)).isFalse();
    }

    @Test void onlyTheActingHandSurvivesTheDelegatedProjection() {
        for (String path : new String[]{"data", "gameView"}) {
            com.google.gson.JsonObject message = new com.google.gson.JsonObject();
            com.google.gson.JsonObject view = new com.google.gson.JsonObject();
            for (String name : new String[]{"myHand", "opponentHands", "watchedHands", "revealed", "lookedAt"}) view.addProperty(name, true);
            com.google.gson.JsonObject data = view;
            if ("gameView".equals(path)) {
                data = new com.google.gson.JsonObject();
                data.add("gameView", view);
            }
            message.add("data", data);
            WebSocketCallbackHandler.removeSharedHands(message);
            assertThat(view.keySet()).containsExactlyInAnyOrder("myHand", "revealed", "lookedAt");
        }
    }

    @Test void openingTheBrowserReplaysOnlyToThatSocketAndPreservesTheAgentDecision() throws Exception {
        UUID table = UUID.randomUUID(), game = UUID.randomUUID();
        List<String> agentFrames = new ArrayList<>(), browserFrames = new ArrayList<>();
        ConnectionState agent = endpoint(agentFrames), browser = endpoint(browserFrames);
        agent.setHumanScope(new HumanTableScope(table.toString(), id -> true));
        HumanSeatChannel seat = new HumanSeatChannel("Alice");
        seat.attach(agent);
        seat.send(start(table, game));
        mage.view.GameView view = mage.server.websocket.rpc.JsonCodec.GSON.fromJson("{}", mage.view.GameView.class);
        seat.send(new ClientCallback(ClientCallbackMethod.GAME_UPDATE, game, view));
        ClientCallback decision = new ClientCallback(ClientCallbackMethod.GAME_SELECT, game);
        decision.setMessageId(73);
        seat.send(decision);
        seat.attach(browser);
        seat.replay(browser);
        assertThat(browser.rejoinSharedGame(game)).isTrue();
        assertThat(browser.resendPrompt(game)).isTrue();
        assertThat(browser.rejoinSharedGame(UUID.randomUUID())).isFalse();
        assertThat(browserFrames).hasSize(6);
        assertThat(agentFrames).hasSize(3);
        assertThatThrownBy(() -> agent.takePrompt(game, 73, () -> { throw RpcException.invalidParams("Replay write failed"); }))
                .isInstanceOf(RpcException.class);
        assertThat(agent.takePrompt(game, 73, NONE)).isTrue();
        assertThat(agent.takePrompt(game, 73, NONE)).isFalse();
    }

    @Test void aSecondTransportReattachesToItsGameAndSharesOnePromptReceipt() throws Exception {
        UUID selected = UUID.randomUUID(), game = UUID.randomUUID(), unrelated = UUID.randomUUID();
        HumanSeatChannel channel = new HumanSeatChannel("Alice");
        List<String> browserFrames = new ArrayList<>(), delegatedFrames = new ArrayList<>();
        ConnectionState browser = endpoint(browserFrames), agent = endpoint(delegatedFrames);
        channel.attach(browser);
        channel.send(start(UUID.randomUUID(), unrelated));
        channel.send(start(selected, game));
        ClientCallback choice = new ClientCallback(ClientCallbackMethod.GAME_SELECT, game);
        choice.setMessageId(42);
        channel.send(choice);
        agent.setHumanScope(new HumanTableScope(selected.toString(), id -> true));
        channel.attach(agent);
        channel.replay(agent);
        assertThat(delegatedFrames).hasSize(2).noneMatch(frame -> frame.contains(unrelated.toString()));
        assertThat(browserFrames).hasSize(3);
        assertThat(agent.takePrompt(game, 41, () -> { throw new AssertionError("Stale response recorded"); })).isFalse();
        assertThat(browser.takePrompt(game, null, NONE)).isTrue();
        assertThat(agent.takePrompt(game, 42, NONE)).isFalse();
        assertThat(agent.resendPrompt(game)).isFalse();
        choice.setMessageId(43);
        channel.send(choice);
        assertThat(agent.takePrompt(game, 43, NONE)).isTrue();
        assertThat(browser.takePrompt(game, null, NONE)).isFalse();
        assertThat(channel.detach(browser)).isFalse();
        channel.send(choice);
        assertThat(agent.takePrompt(game, 43, NONE)).isTrue();
        assertThat(channel.detach(agent)).isTrue();
    }
}
