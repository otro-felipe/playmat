package mage.server.game;

import mage.constants.MultiplayerAttackOption;
import mage.constants.RangeOfInfluence;
import mage.game.Game;
import mage.game.GameImpl;
import mage.game.GameState;
import mage.game.match.Match;
import mage.game.match.MatchPlayer;
import mage.game.match.MatchType;
import mage.game.mulligan.LondonMulligan;
import mage.players.StubPlayer;
import mage.view.GameView;
import org.junit.Test;

import java.lang.reflect.Proxy;
import java.util.UUID;

import static org.junit.Assert.*;

public class PriorityAssignmentClockTest {
    @Test public void repeatedObservationAndStateRestorationPreserveTheOriginalHandoff() throws InterruptedException {
        GameState state = new GameState();
        UUID first = UUID.randomUUID();
        UUID second = UUID.randomUUID();
        assertEquals(0L, state.getPriorityAssignedAtEpochMs());

        state.setPriorityPlayerId(first);
        long assigned = state.getPriorityAssignedAtEpochMs();
        assertTrue(assigned > 0);
        GameState saved = state.copy();
        assertEquals(assigned, saved.getPriorityAssignedAtEpochMs());

        // Ensure the assertion detects a setter that refreshes on every call.
        Thread.sleep(5);
        state.setPriorityPlayerId(first);
        assertEquals(assigned, state.getPriorityAssignedAtEpochMs());
        state.setPriorityPlayerId(second);
        assertTrue(state.getPriorityAssignedAtEpochMs() > assigned);

        state.restoreForRollBack(saved);
        assertEquals(first, state.getPriorityPlayerId());
        assertEquals(assigned, state.getPriorityAssignedAtEpochMs());
        state.setPriorityPlayerId(null);
        assertEquals(0L, state.getPriorityAssignedAtEpochMs());
    }

    @Test public void onlyTheLivePriorityHolderSeesTheEngineTime() {
        Game game = new Duel();
        GameState state = game.getState();
        StubPlayer first = new StubPlayer("First", RangeOfInfluence.ALL);
        StubPlayer second = new StubPlayer("Second", RangeOfInfluence.ALL);
        Match match = (Match) Proxy.newProxyInstance(Match.class.getClassLoader(), new Class<?>[]{Match.class},
                (proxy, method, args) -> {
                    if (method.getName().equals("getWinsNeeded")) return 1;
                    throw new UnsupportedOperationException(method.getName());
                });
        first.setMatchPlayer(new MatchPlayer(first, null, match));
        second.setMatchPlayer(new MatchPlayer(second, null, match));
        state.addPlayer(first);
        state.addPlayer(second);
        state.setPriorityPlayerId(first.getId());
        long assigned = state.getPriorityAssignedAtEpochMs();

        assertTrue(assigned > 0);
        assertEquals(assigned, new GameView(state, game, first.getId(), null).getPriorityAssignedAtEpochMs());
        assertEquals(0L, new GameView(state, game, second.getId(), null).getPriorityAssignedAtEpochMs());
        assertEquals(0L, new GameView(state, game, null, UUID.randomUUID()).getPriorityAssignedAtEpochMs());
        assertEquals(0L, GameView.forReplay(game, first.getId(), null).getPriorityAssignedAtEpochMs());
    }

    private static class Duel extends GameImpl {
        Duel() { super(MultiplayerAttackOption.LEFT, RangeOfInfluence.ALL, new LondonMulligan(0), 60, 20, 7); }
        @Override public MatchType getGameType() { return null; }
        @Override public int getNumPlayers() { return 2; }
        @Override public Game copy() { throw new UnsupportedOperationException(); }
    }
}
