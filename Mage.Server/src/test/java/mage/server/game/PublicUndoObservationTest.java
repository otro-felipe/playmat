package mage.server.game;

import mage.constants.RangeOfInfluence;
import mage.game.Game;
import mage.game.GameState;
import mage.game.stack.SpellStack;
import mage.game.stack.StackObject;
import mage.players.StubPlayer;
import org.junit.After;
import org.junit.Test;

import java.lang.reflect.Proxy;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

import static org.junit.Assert.*;

public class PublicUndoObservationTest {
    private final UUID gameId = UUID.randomUUID();
    private final GameEventFeed feed = GameEventFeed.open(gameId);
    private final Pilot player = new Pilot();
    private final SpellStack stack = new SpellStack();
    private final List<Long> countsAtPublication = new ArrayList<>();
    @After public void close() { GameEventFeed.close(gameId); }
    private static class Pilot extends StubPlayer {
        int restoreCalls;
        boolean restoreSucceeds = true;
        Pilot() { super("Synthetic public undo", RangeOfInfluence.ALL); }
        @Override public GameState restoreState(int bookmark, String text, Game game) {
            restoreCalls++;
            return restoreSucceeds ? new GameState() : null;
        }
    }
    private Game game() {
        return (Game) Proxy.newProxyInstance(Game.class.getClassLoader(), new Class<?>[]{Game.class}, (proxy, method, args) -> {
            switch (method.getName()) {
                case "getId": return gameId;
                case "getPlayer": return args[0].equals(player.getId()) ? player : null;
                case "getStack": return stack;
                case "isSimulation": return false;
                case "fireUpdatePlayersEvent":
                    countsAtPublication.add(feed.sequenceEvidence().getPublicActions().getOrDefault(player.getId(), 0L));
                    return null;
                case "undo": throw new AssertionError("A void undo result must not be assumed to be a successful restore");
                default: if (method.getReturnType() == boolean.class) return false; return null;
            }
        });
    }
    @Test public void aSuccessfulOldBookmarkUndoIsObservedBeforePublishingRestoredState() {
        feed.publicAction(player.getId()); // The earlier mana activation predates this plan.
        player.setStoredBookmark(42);
        assertEquals(Long.valueOf(1), feed.sequenceEvidence().getPublicActions().get(player.getId()));
        assertTrue(GameController.applyPublicUndo(game(), player.getId()));
        assertEquals(1, player.restoreCalls);
        assertEquals(-1, player.getStoredBookmark());
        assertEquals(Long.valueOf(2), feed.sequenceEvidence().getPublicActions().get(player.getId()));
        assertEquals(java.util.Collections.singletonList(2L), countsAtPublication);
    }
    @Test public void rejectedPaymentStackAndMissingBookmarkActionsNeverCount() {
        Game g = game();
        assertFalse(GameController.applyPublicUndo(g, player.getId()));
        player.setStoredBookmark(42);
        player.setPayManaMode(true);
        assertFalse(GameController.applyPublicUndo(g, player.getId()));
        player.setPayManaMode(false);
        stack.add((StackObject) Proxy.newProxyInstance(StackObject.class.getClassLoader(), new Class<?>[]{StackObject.class}, (p, m, a) -> null));
        assertFalse(GameController.applyPublicUndo(g, player.getId()));
        assertEquals(0, player.restoreCalls);
        assertTrue(feed.sequenceEvidence().getPublicActions().isEmpty());
        assertTrue(countsAtPublication.isEmpty());
    }
    @Test public void anInvalidBookmarkRestoreKeepsExistingRefreshBehaviorButDoesNotCountAsAnAction() {
        player.setStoredBookmark(42);
        player.restoreSucceeds = false;
        assertFalse(GameController.applyPublicUndo(game(), player.getId()));
        assertEquals(1, player.restoreCalls);
        assertEquals(-1, player.getStoredBookmark());
        assertTrue(feed.sequenceEvidence().getPublicActions().isEmpty());
        assertEquals(java.util.Collections.singletonList(0L), countsAtPublication);
    }
}
