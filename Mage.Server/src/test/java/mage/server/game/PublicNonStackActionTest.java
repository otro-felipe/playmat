package mage.server.game;

import mage.abilities.ActivatedAbilityImpl;
import mage.abilities.Ability;
import mage.cards.Cards;
import mage.cards.CardsImpl;
import mage.abilities.mana.ActivatedManaAbilityImpl;
import mage.constants.AbilityType;
import mage.constants.RangeOfInfluence;
import mage.constants.Zone;
import mage.game.Game;
import mage.game.events.PublicActionObservations;
import mage.players.StubPlayer;
import org.junit.After;
import org.junit.Test;

import java.lang.reflect.Proxy;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.Assert.*;

/** Exercises the actual PlayerImpl mana/no-stack entry points, not a fabricated ACTIVATED_ABILITY event. */
public class PublicNonStackActionTest {
    private final UUID gameId = UUID.randomUUID();
    private final GameEventFeed feed = GameEventFeed.open(gameId);
    private final AtomicInteger rulesEvents = new AtomicInteger();
    private final Pilot player = new Pilot();
    @After public void close() { GameEventFeed.close(gameId); }

    private static class Pilot extends StubPlayer {
        Pilot() { super("Synthetic observer pilot", RangeOfInfluence.ALL); }
        Cards discarded = new CardsImpl();
        @Override public Cards discard(int amount, boolean random, boolean payForCost, Ability source, Game game) { return discarded; }
        boolean mana(Game game) { return playManaAbility(new Mana(), game); }
        boolean direct(Game game) { return playAbility(new Direct(), game); }
    }
    private static class Mana extends ActivatedManaAbilityImpl {
        Mana() { super(Zone.BATTLEFIELD, null, null); }
        @Override public boolean activate(Game game, boolean noMana) { return true; }
        @Override public boolean resolve(Game game) { return true; }
        @Override public Mana copy() { return new Mana(); }
    }
    private static class Direct extends ActivatedAbilityImpl {
        Direct() { super(AbilityType.ACTIVATED_NONMANA, Zone.BATTLEFIELD); this.usesStack = false; }
        @Override public boolean activate(Game game, boolean noMana) { return true; }
        @Override public boolean resolve(Game game) { return true; }
        @Override public Direct copy() { return new Direct(); }
    }
    private Game game(boolean simulation) {
        return (Game) Proxy.newProxyInstance(Game.class.getClassLoader(), new Class<?>[]{Game.class}, (proxy, method, args) -> {
            switch (method.getName()) {
                case "getId": return gameId;
                case "isSimulation": return simulation;
                case "bookmarkState": return 1;
                case "fireEvent": rulesEvents.incrementAndGet(); return null;
                default:
                    if (method.getReturnType() == boolean.class) return false;
                    if (method.getReturnType() == int.class) return 0;
                    return null;
            }
        });
    }
    @Test public void acceptedManaAndDirectAbilitiesCountOnceWithoutAnyRulesEvent() {
        Game actual = game(false);
        assertTrue(player.mana(actual));
        assertEquals(Long.valueOf(1), feed.sequenceEvidence().getPublicActions().get(player.getId()));
        assertTrue(player.direct(actual));
        assertEquals(Long.valueOf(2), feed.sequenceEvidence().getPublicActions().get(player.getId()));
        assertEquals("Observation must not trigger rules events", 0, rulesEvents.get());
        assertSame("Opening an existing feed cannot double-register observation", feed, GameEventFeed.open(gameId));
        assertTrue(player.mana(actual));
        assertEquals(Long.valueOf(3), feed.sequenceEvidence().getPublicActions().get(player.getId()));
    }
    @Test public void simulationAbilitiesDoNotBecomeRealPublicActions() {
        assertTrue(player.mana(game(true)));
        assertTrue(player.direct(game(true)));
        assertTrue(feed.sequenceEvidence().getPublicActions().isEmpty());
        assertEquals(0, rulesEvents.get());
    }
    @Test public void publicCleanupChoiceCountsButEffectCausedDiscardDoesNot() {
        Game actual = game(false);
        UUID chosen = UUID.randomUUID();
        player.getHand().add(chosen);
        player.setMaxHandSize(0);
        player.discarded.add(chosen);
        player.discardToMax(actual);
        assertEquals(Long.valueOf(1), feed.sequenceEvidence().getPublicActions().get(player.getId()));
        // The ordinary discard entry point used by Mind Rot and other effects is not an actor signal.
        player.discard(1, false, false, null, actual);
        assertEquals(Long.valueOf(1), feed.sequenceEvidence().getPublicActions().get(player.getId()));
        assertEquals(0, rulesEvents.get());
    }
    @Test public void aCleanupAttemptWithoutAnyActualPublicDiscardDoesNotCount() {
        player.getHand().add(UUID.randomUUID());
        player.setMaxHandSize(0);
        player.discardToMax(game(false));
        assertTrue(feed.sequenceEvidence().getPublicActions().isEmpty());
    }
    @Test public void observerFailureAndCloseNeverLeaveApparentlyValidEvidence() {
        PublicActionObservations.close(gameId);
        assertNull(feed.sequenceEvidence());
        PublicActionObservations.register(gameId, ignored -> { throw new IllegalStateException("synthetic failure"); });
        PublicActionObservations.accepted(gameId, player.getId());
        assertFalse(PublicActionObservations.isObserved(gameId));
        assertNull(feed.sequenceEvidence());
        GameEventFeed.close(gameId);
        assertFalse(PublicActionObservations.isObserved(gameId));
    }
}
