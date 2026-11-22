package mage.server.websocket;

import com.google.gson.JsonArray;
import mage.server.websocket.api.ApiContext;
import mage.server.websocket.api.WebClientApi;
import mage.server.websocket.rpc.JsonCodec;
import mage.server.websocket.rpc.RpcDispatcher;
import mage.server.websocket.rpc.RpcException;
import mage.server.websocket.rpc.RpcMethod;
import org.junit.jupiter.api.Test;

import java.util.UUID;

import static org.assertj.core.api.Assertions.*;

class HumanBrowserControlTest {
    private final UUID table = UUID.randomUUID(), game = UUID.randomUUID(), chat = UUID.randomUUID();
    private final UUID other = UUID.randomUUID();
    private final RpcDispatcher registry = WebClientApi.createDispatcher(new ApiContext(null, null, null, ""));
    private final HumanBrowserControl scope = new HumanBrowserControl(id -> id.equals(game) ? table : other,
            id -> id.equals(chat) ? table : null, id -> !id.equals(table));

    private void request(String method, Object... params) throws RpcException {
        RpcMethod definition = registry.find(method);
        assertThat(definition).as(method).isNotNull();
        JsonArray arguments = JsonCodec.GSON.toJsonTree(params).getAsJsonArray();
        scope.check(definition, arguments);
    }

    @Test void aDelegatedSeatHasIndependentPriorityAndManaPreferences() {
        mage.players.net.UserData browser = mage.players.net.UserData.getDefaultUserDataView();
        browser.getUserSkipPrioritySteps().getYourTurn().setBeforeCombat(false);
        browser.getUserSkipPrioritySteps().getOpponentTurn().setBeforeCombat(true);
        browser.setManaPoolAutomatic(false);
        browser.setPassPriorityActivation(true);
        mage.server.User user = new mage.server.User(null, "Alice", "localhost", null) {
            @Override public boolean browserMayPlay(UUID id) { return !table.equals(id); }
            @Override public mage.players.net.UserData getUserData() { return browser; }
        };
        mage.players.net.UserData delegated = user.preferencesForTable(table);
        assertThat(delegated).isNotSameAs(browser);
        assertThat(delegated.getUserSkipPrioritySteps().getYourTurn().isBeforeCombat()).isTrue();
        assertThat(delegated.getUserSkipPrioritySteps().getOpponentTurn().isBeforeCombat()).isFalse();
        assertThat(delegated.getUserSkipPrioritySteps().getYourTurn().isDraw()).isTrue();
        assertThat(delegated.getUserSkipPrioritySteps().getOpponentTurn().isUpkeep()).isTrue();
        assertThat(delegated.getUserSkipPrioritySteps().getOpponentTurn().isEndOfTurn()).isTrue();
        assertThat(delegated.isManaPoolAutomaticRestricted()).isTrue();
        assertThat(delegated.isPassPriorityActivation()).isFalse();
        assertThat(user.preferencesForTable(other)).isSameAs(browser);
        assertThat(browser.getUserSkipPrioritySteps().getYourTurn().isBeforeCombat()).isFalse();
        assertThat(browser.getUserSkipPrioritySteps().getOpponentTurn().isBeforeCombat()).isTrue();
        assertThat(browser.isManaPoolAutomatic()).isFalse();
        assertThat(browser.getUserSkipPrioritySteps().getYourTurn().isDraw()).isFalse();
    }

    @Test void ownerCanObserveAndStartButCannotControlAnOptedInMatchEvenWithoutAnAgentSocket() throws Exception {
        request("matchStart", null, other, table);
        request("gameJoin", game, null);
        request("gameResync", game, null);
        request("gameStateResync", game, null);
        request("chatJoin", chat, null);
        request("chatFindByGame", game);
        request("roomGetTableById", other, table);
        for (String method : new String[]{"sendPlayerUUID", "sendPlayerBoolean", "sendPlayerString", "sendPlayerInteger",
                "sendPlayerManaType", "matchQuit", "gamePractice", "gameEmote", "cheatShow", "soloSaveAndLeave", "soloWhatIf"}) {
            assertThatThrownBy(() -> request(method, game, null, true)).as(method).isInstanceOf(RpcException.class);
        }
        assertThatThrownBy(() -> request("sendPlayerAction", "CONCEDE", game, null)).isInstanceOf(RpcException.class);
        assertThatThrownBy(() -> request("chatSendMessage", chat, null, "hola")).isInstanceOf(RpcException.class);
        assertThatThrownBy(() -> request("chatLeave", chat, null)).isInstanceOf(RpcException.class);
        assertThatThrownBy(() -> request("deckSubmit", null, table)).isInstanceOf(RpcException.class);
        assertThatThrownBy(() -> request("submitDeck", null, table)).isInstanceOf(RpcException.class);
        assertThatThrownBy(() -> request("tableRemove", null, other, table)).isInstanceOf(RpcException.class);
        request("sendPlayerBoolean", other, null, true);
        request("deckSubmit", null, other);
        request("chatSendMessage", other, null, "hola");
    }
}
