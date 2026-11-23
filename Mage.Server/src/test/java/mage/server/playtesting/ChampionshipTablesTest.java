package mage.server.playtesting;

import com.google.gson.JsonObject;
import mage.constants.TableState;
import mage.game.Game;
import mage.game.Table;
import mage.game.match.Match;
import org.junit.jupiter.api.Test;

import java.lang.reflect.Proxy;
import java.util.Collections;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.*;

class ChampionshipTablesTest {
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
