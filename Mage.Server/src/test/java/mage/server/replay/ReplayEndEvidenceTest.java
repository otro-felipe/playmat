package mage.server.replay;

import com.google.gson.JsonObject;
import mage.game.Game;
import mage.game.GameOptions;
import mage.game.GameState;
import mage.game.match.ChampionshipRules;
import mage.players.Player;
import mage.players.Players;
import org.junit.jupiter.api.Test;

import java.lang.reflect.Proxy;
import java.util.*;

import static org.junit.jupiter.api.Assertions.*;

class ReplayEndEvidenceTest {
    private final UUID gameId = UUID.randomUUID(), playerId = UUID.randomUUID();
    private final GameState state = new GameState();
    private final GameOptions options = new GameOptions();
    private final Set<String> flags = new HashSet<>();
    private final Players players = new Players();
    private final Map<UUID, ReplayRecorder.Departure> departures = new HashMap<>();
    private final Game game = (Game) Proxy.newProxyInstance(Game.class.getClassLoader(), new Class<?>[]{Game.class},
            (p, method, args) -> {
                switch (method.getName()) {
                    case "getId": return gameId;
                    case "getOptions": return options;
                    case "getState": return state;
                    case "getPlayers": return players;
                    default: throw new UnsupportedOperationException(method.getName());
                }
            });

    @Test
    void administrativeCloseDoesNotBecomeAnOutcomeAndEndCausesRequireGameEvidence() {
        Player player = (Player) Proxy.newProxyInstance(Player.class.getClassLoader(), new Class<?>[]{Player.class},
                (p, method, args) -> method.getName().equals("getId") ? playerId : flags.contains(method.getName()));
        players.put(playerId, player);
        assertFalse(ReplayRecorder.endMarker(game, "Game is a draw", departures).get("terminal").getAsBoolean());
        state.endGame();
        assertFalse(ReplayRecorder.endMarker(game, null, departures).get("terminal").getAsBoolean());
        JsonObject normal = ReplayRecorder.endMarker(game, "Game is a draw", departures);
        assertTrue(normal.get("terminal").getAsBoolean());
        assertFalse(normal.has("cause"));

        departures.put(playerId, ReplayRecorder.Departure.CONCESSION);
        assertFalse(ReplayRecorder.endMarker(game, "finished", departures).has("cause"));
        flags.add("hasLost");
        assertEquals("concession", cause());
        departures.put(playerId, ReplayRecorder.Departure.DISCONNECT);
        assertEquals("disconnect", cause());
        flags.add("hasTimerTimeout");
        assertEquals("player_clock", cause());
        flags.remove("hasTimerTimeout");
        flags.add("hasIdleTimeout");
        assertEquals("inactivity", cause());
        flags.clear();
        options.championship = new ChampionshipRules(UUID.randomUUID(), "a", "b", false, 1, 1L);
        assertFalse(ReplayRecorder.endMarker(game, "finished", departures).has("cause"), "elapsed wall time is insufficient");
        options.championship.clockEndedGame = gameId;
        assertEquals("round_clock", cause());
    }

    private String cause() {
        return ReplayRecorder.endMarker(game, "finished", departures).get("cause").getAsString();
    }
}
