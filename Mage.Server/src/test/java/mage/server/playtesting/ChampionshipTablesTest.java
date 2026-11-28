package mage.server.playtesting;

import com.google.gson.JsonObject;
import mage.constants.TableState;
import mage.game.Game;
import mage.game.Table;
import mage.game.match.Match;
import mage.server.managers.GameManager;
import mage.server.managers.ManagerFactory;
import mage.server.managers.TableManager;
import org.junit.jupiter.api.Test;

import java.lang.reflect.Proxy;
import java.util.Collections;
import java.util.Optional;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.*;

class ChampionshipTablesTest {
    @Test
    void stoppedChampionshipPairingCannotBePreparedByALateBridgeTick() throws Exception {
        UUID table = UUID.randomUUID();
        TableManager tables = (TableManager) Proxy.newProxyInstance(TableManager.class.getClassLoader(),
                new Class<?>[]{TableManager.class}, (proxy, method, args) -> {
                    assertEquals("getController", method.getName());
                    assertEquals(table, args[0]);
                    return Optional.empty();
                });
        GameManager games = (GameManager) Proxy.newProxyInstance(GameManager.class.getClassLoader(),
                new Class<?>[]{GameManager.class}, (proxy, method, args) -> {
                    assertEquals("getGameController", method.getName());
                    return Collections.emptyMap();
                });
        ManagerFactory managers = (ManagerFactory) Proxy.newProxyInstance(ManagerFactory.class.getClassLoader(),
                new Class<?>[]{ManagerFactory.class}, (proxy, method, args) -> {
                    if ("tableManager".equals(method.getName())) return tables;
                    assertEquals("gameManager", method.getName());
                    return games;
                });
        ChampionshipTables championship = new ChampionshipTables(managers);
        UUID pairing = UUID.randomUUID();
        JsonObject request = new JsonObject();
        request.addProperty("action", "abort");
        request.addProperty("pairingId", pairing.toString());
        request.addProperty("tableId", table.toString());
        JsonObject receipt = championship.execute(request);
        assertEquals("UNAVAILABLE", receipt.get("state").getAsString());
        assertEquals(pairing.toString(), receipt.get("pairingId").getAsString());
        assertEquals(table.toString(), receipt.get("tableId").getAsString());
        request.addProperty("action", "prepare");
        assertNull(championship.execute(request));
    }

    @Test
    void allocatedGameWithoutRegisteredSessionIsNeverPublished() {
        UUID id = UUID.randomUUID();
        Game allocated = (Game) Proxy.newProxyInstance(Game.class.getClassLoader(), new Class<?>[]{Game.class},
                (p, method, args) -> "getId".equals(method.getName()) ? id : null);
        Match match = (Match) Proxy.newProxyInstance(Match.class.getClassLoader(), new Class<?>[]{Match.class},
                (p, method, args) -> {
                    if ("getGame".equals(method.getName())) return allocated;
                    if ("getGamesInfo".equals(method.getName())) return Collections.emptyList();
                    return null;
                });
        Table table = new Table(UUID.randomUUID(), "Duel", "Test", "Owner", null, Collections.emptyList(),
                ignored -> {}, match, Collections.emptySet(), false);
        table.setState(TableState.DUELING);
        for (boolean registered : new boolean[]{true, false}) {
            JsonObject view = new JsonObject();
            ChampionshipTables.addGameStatus(view, table, registered, Collections.emptyMap());
            assertFalse(view.get("gameStarted").getAsBoolean());
            assertFalse(view.has("gameId"));
        }
    }
}
