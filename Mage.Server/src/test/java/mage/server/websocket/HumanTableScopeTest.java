package mage.server.websocket;

import com.google.gson.JsonArray;
import com.google.gson.JsonParser;
import mage.interfaces.callback.ClientCallback;
import mage.interfaces.callback.ClientCallbackMethod;
import mage.server.recovery.RecoveryPrincipal;
import mage.server.websocket.rpc.RpcException;
import mage.view.TableClientMessage;
import org.junit.jupiter.api.Test;

import java.util.UUID;
import java.util.concurrent.atomic.AtomicBoolean;

import static org.assertj.core.api.Assertions.*;

class HumanTableScopeTest {
    final UUID table = UUID.randomUUID(), game = UUID.randomUUID(), other = UUID.randomUUID();
    final AtomicBoolean active = new AtomicBoolean(true);
    HumanTableScope scope(String request) { return new HumanTableScope(request, id -> active.get()); }
    JsonArray params(Object... values) { return mage.server.websocket.rpc.JsonCodec.GSON.toJsonTree(values).getAsJsonArray(); }
    ClientCallback start(UUID table) { return new ClientCallback(ClientCallbackMethod.START_GAME, game,
            new TableClientMessage().withTable(table, null).withGame(game).withPlayer(UUID.randomUUID())); }

    @Test void aDelegatedSeatFollowsOnlyItsTableAndActiveGrant() throws Exception {
        HumanTableScope scope = scope(table.toString());
        assertThat(scope.accept(start(other))).isFalse();
        assertThatThrownBy(() -> scope.check("gameJoin", params(game, null))).isInstanceOf(RpcException.class);
        assertThat(scope.accept(start(table))).isTrue();
        scope.check("gameJoin", params(game, null));
        assertThatThrownBy(() -> scope.check("gameJoin", params(other, null))).isInstanceOf(RpcException.class);
        assertThatThrownBy(() -> scope.check("sessionGetRestoreToken", params())).isInstanceOf(RpcException.class);
        assertThatThrownBy(() -> scope.check("sendPlayerAction", params("REQUEST_PERMISSION_TO_SEE_HAND_CARDS", game, null))).isInstanceOf(RpcException.class);
        assertThat(scope.accept(new ClientCallback(ClientCallbackMethod.GAME_ASK, other))).isFalse();
        active.set(false);
        assertThat(scope.accept(new ClientCallback(ClientCallbackMethod.GAME_ASK, game))).isFalse();
        assertThatThrownBy(() -> scope.check("gameJoin", params(game, null))).isInstanceOf(RpcException.class);
    }

    @Test void creationWithControlDisabledCanStartOnlyTheCreatedTable() throws Exception {
        HumanTableScope scope = scope("create");
        scope.check("roomCreateTable", params(null, other, JsonParser.parseString("{\"humanMcpAllowed\":false}")));
        scope.created(table, false);
        scope.check("matchStart", params(null, other, table));
        assertThatThrownBy(() -> scope.check("matchStart", params(null, other, other))).isInstanceOf(RpcException.class);
        assertThat(scope.accept(start(table))).isFalse();
        assertThatThrownBy(() -> scope.check("gameJoin", params(game, null))).isInstanceOf(RpcException.class);
        assertThatThrownBy(() -> scope.check("roomCreateTable", params())).isInstanceOf(RpcException.class);
    }

    @Test void aRecoveredCreatorCanStartItsWaitingTableWithoutPlaying() throws Exception {
        HumanTableScope scope = new HumanTableScope("start:" + table, table::equals);
        scope.check("connectUser", params("Alice"));
        scope.check("tableIsOwner", params(null, other, table));
        scope.check("matchStart", params(null, other, table));
        assertThatThrownBy(() -> scope.check("matchStart", params(null, table, other))).isInstanceOf(RpcException.class);
        assertThatThrownBy(() -> scope.check("roomJoinTable", params(null, other, table))).isInstanceOf(RpcException.class);
        assertThatThrownBy(() -> scope.check("tableRemove", params(null, other, table))).isInstanceOf(RpcException.class);
        assertThat(scope.accept(start(table))).isFalse();
        assertThatThrownBy(() -> scope.check("gameJoin", params(game, null))).isInstanceOf(RpcException.class);
    }

    @Test void onlyAnInternalHumanConnectionCanRequestDelegation() {
        UUID owner = UUID.randomUUID();
        RecoveryPrincipal human = new RecoveryPrincipal(owner, "human:" + owner, UUID.randomUUID());
        assertThat(HumanTableScope.validHeader("create", true, human)).isTrue();
        assertThat(HumanTableScope.validHeader(table.toString(), true, human)).isTrue();
        assertThat(HumanTableScope.validHeader("start:" + table, true, human)).isTrue();
        assertThat(HumanTableScope.validHeader("create", false, human)).isFalse();
        assertThat(HumanTableScope.validHeader("create", true, new RecoveryPrincipal(owner, "human:" + owner))).isFalse();
        assertThat(HumanTableScope.validHeader("create", true, new RecoveryPrincipal(owner, "agent:" + other, UUID.randomUUID()))).isFalse();
        assertThat(HumanTableScope.validHeader("bad", true, human)).isFalse();
    }
}
