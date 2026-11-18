package mage.server.game;

import com.google.gson.Gson;
import mage.abilities.Ability;
import mage.cards.CardSetInfo;
import mage.cards.m.MonasterySwiftspear;
import mage.constants.Rarity;
import mage.constants.Zone;
import mage.game.Game;
import mage.game.GameState;
import mage.game.events.GameEvent;
import mage.game.events.PublicActionObservations;
import mage.game.stack.SpellStack;
import mage.game.stack.Spell;
import mage.game.stack.StackObject;
import mage.players.Player;
import mage.view.SequenceEvidenceView;
import org.junit.After;
import org.junit.Test;

import java.lang.reflect.Proxy;
import java.util.Map;
import java.util.HashMap;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.Assert.*;

/** Public resolution evidence and PM-AC-09-CREATURE regression boundaries. */
public class GameEventRecorderEvidenceTest {
    private final UUID gameId = UUID.randomUUID();
    private final UUID own = UUID.randomUUID(), rival = UUID.randomUUID();
    private final UUID stackId = UUID.randomUUID(), abilityId = UUID.randomUUID();
    private final GameEventFeed feed = GameEventFeed.open(gameId);
    private final SpellStack stack = new SpellStack();
    private final Game game = stub(Game.class, values("getId", gameId, "getStack", stack, "isSimulation", false));
    private final GameEventRecorder recorder = new GameEventRecorder(gameId);

    @After public void close() { GameEventFeed.close(gameId); }

    private static Map<String, Object> values(Object... pairs) {
        Map<String, Object> result = new HashMap<>();
        for (int i = 0; i < pairs.length; i += 2) result.put((String) pairs[i], pairs[i + 1]);
        return result;
    }

    @SuppressWarnings("unchecked")
    private static <T> T stub(Class<T> type, Map<String, Object> values) {
        return (T) Proxy.newProxyInstance(type.getClassLoader(), new Class<?>[]{type}, (proxy, method, args) -> {
            if (values.containsKey(method.getName())) return values.get(method.getName());
            if (method.getReturnType() == boolean.class) return false;
            if (method.getReturnType() == int.class) return 0;
            return null;
        });
    }
    private GameEvent event(GameEvent.EventType type, UUID target, UUID actor) {
        return new GameEvent(type, target, (Ability) null, actor);
    }
    private void resolvingOwn() {
        Ability ability = stub(Ability.class, values("getOriginalId", abilityId));
        StackObject object = stub(StackObject.class, values("getId", stackId, "getControllerId", own, "getStackAbility", ability));
        stack.add(object);
        PublicActionObservations.resolving(gameId, stackId);
    }
    @Test public void ownResolutionAndRivalActivationInOneBatchKeepDistinctCausality() {
        resolvingOwn();
        recorder.watch(event(GameEvent.EventType.LOST_LIFE, rival, rival), game);
        recorder.watch(event(GameEvent.EventType.TAPPED, UUID.randomUUID(), rival), game);
        assertFalse("Damage and tapping recipients are not actors", feed.sequenceEvidence().getPublicActions().containsKey(rival));
        recorder.watch(event(GameEvent.EventType.ACTIVATED_ABILITY, UUID.randomUUID(), rival), game);
        SequenceEvidenceView view = feed.sequenceEvidence();
        assertEquals(Long.valueOf(1), view.getPublicActions().get(rival));
        assertEquals(Long.valueOf(1), view.getResolutions().get(stackId));
    }
    @Test public void privateDrawsAndSelectionsAddNoEvidenceOrPrivateIdentity() {
        UUID secretCard = UUID.randomUUID();
        recorder.watch(event(GameEvent.EventType.DREW_CARD, secretCard, rival), game);
        recorder.watch(event(GameEvent.EventType.CAST_SPELL, secretCard, rival), game); // attempt, not committed
        String json = new Gson().toJson(feed.sequenceEvidence());
        assertFalse(json.contains(secretCard.toString()));
        assertTrue(feed.sequenceEvidence().getPublicActions().isEmpty());
        assertTrue(feed.sequenceEvidence().getResolutions().isEmpty());
    }
    @Test public void abilityEventsCannotInventAnotherStackResolution() {
        resolvingOwn();
        recorder.watch(event(GameEvent.EventType.RESOLVING_ABILITY, UUID.randomUUID(), rival), game);
        assertEquals(1, feed.sequenceEvidence().getResolutionRevision());
        assertEquals(1, feed.sequenceEvidence().getResolutions().size());
    }
    @Test public void boundedHistoryAdvertisesItsDiscontinuityAndSnapshotIsIndependent() {
        SequenceEvidenceView before = feed.sequenceEvidence();
        for (int i = 0; i < GameEventFeed.RESOLUTION_CAPACITY + 2; i++) feed.beginResolution(UUID.randomUUID());
        SequenceEvidenceView after = feed.sequenceEvidence();
        assertEquals(GameEventFeed.RESOLUTION_CAPACITY, after.getResolutions().size());
        assertEquals(GameEventFeed.RESOLUTION_CAPACITY + 2, after.getResolutionRevision());
        assertEquals(0, before.getResolutionRevision());
        assertTrue(before.getResolutions().isEmpty());
        GameEventFeed.close(gameId);
        assertNotEquals(after.getEpoch(), GameEventFeed.open(gameId).sequenceEvidence().getEpoch());
    }

    @Test public void permanentSpellResolutionIsWitnessedBeforeMovingToBattlefieldWithoutAbilityEvent() {
        StackObject permanentSpell = (StackObject) Proxy.newProxyInstance(StackObject.class.getClassLoader(), new Class<?>[]{StackObject.class}, (proxy, method, args) -> {
            switch (method.getName()) {
                case "getId": return stackId;
                case "resolve":
                    Long witnessedAtEntry = feed.sequenceEvidence().getResolutions().get(stackId);
                    stack.poll();
                    assertEquals("Evidence must exist before permanent-entry effects publish a view", Long.valueOf(1), witnessedAtEntry);
                    return true;
                case "equals": return proxy == args[0];
                default: return null;
            }
        });
        stack.add(permanentSpell);
        stack.resolve(game);
        assertEquals(1, feed.sequenceEvidence().getResolutionRevision());
        assertTrue("Resolving is not a new public player action", feed.sequenceEvidence().getPublicActions().isEmpty());
    }

    @Test public void oneStackResolutionWithMultipleAbilityEventsIsWitnessedOnlyOnce() {
        Ability ability = stub(Ability.class, values("getOriginalId", abilityId));
        StackObject spell = (StackObject) Proxy.newProxyInstance(StackObject.class.getClassLoader(), new Class<?>[]{StackObject.class}, (proxy, method, args) -> {
            switch (method.getName()) {
                case "getId": return stackId;
                case "getControllerId": return own;
                case "getStackAbility": return ability;
                case "equals": return proxy == args[0];
                case "resolve":
                    recorder.watch(event(GameEvent.EventType.RESOLVING_ABILITY, abilityId, own), game);
                    recorder.watch(event(GameEvent.EventType.RESOLVING_ABILITY, abilityId, own), game);
                    stack.poll();
                    return true;
                default: return null;
            }
        });
        stack.add(spell);
        stack.resolve(game);
        assertEquals("One public stack object, not one event per selected mode", 1, feed.sequenceEvidence().getResolutionRevision());
    }

    @Test public void monasterySwiftspearActualSpellPathProducesPublicEvidenceBeforePermanentMovement() {
        AtomicInteger moves = new AtomicInteger();
        Player player = (Player) Proxy.newProxyInstance(Player.class.getClassLoader(), new Class<?>[]{Player.class}, (proxy, method, args) -> {
            if (method.getName().equals("moveCards")) {
                assertEquals(Zone.BATTLEFIELD, args[1]);
                UUID resolvingId = stack.peek().getId();
                Long witnessedBeforeMovement = feed.sequenceEvidence().getResolutions().get(resolvingId);
                moves.incrementAndGet();
                stack.poll();
                assertEquals(Long.valueOf(1), witnessedBeforeMovement);
                return true;
            }
            if (method.getName().equals("getId")) return own;
            return null;
        });
        Game permanentGame = stub(Game.class, values("getId", gameId, "getStack", stack, "isSimulation", false, "getState", new GameState(), "getPlayer", player));
        MonasterySwiftspear card = new MonasterySwiftspear(own, new CardSetInfo("Monastery Swiftspear", "KTK", "118", Rarity.UNCOMMON));
        Spell spell = new Spell(card, card.getSpellAbility(), own, Zone.HAND, permanentGame);
        stack.add(spell);
        stack.resolve(permanentGame);
        assertEquals(1, moves.get());
        assertEquals(Long.valueOf(1), feed.sequenceEvidence().getResolutions().get(spell.getId()));
        assertFalse("Only the announced stack ID is evidence", feed.sequenceEvidence().getResolutions().containsKey(card.getId()));
    }

    @Test public void failedResolutionObserverDoesNotPreventResolutionAndDisablesEvidence() {
        PublicActionObservations.close(gameId);
        PublicActionObservations.register(gameId, actor -> { });
        PublicActionObservations.registerResolutions(gameId, id -> { throw new IllegalStateException("Synthetic observer failure"); });
        AtomicInteger resolved = new AtomicInteger();
        StackObject object = (StackObject) Proxy.newProxyInstance(StackObject.class.getClassLoader(), new Class<?>[]{StackObject.class}, (proxy, method, args) -> {
            if (method.getName().equals("getId")) return stackId;
            if (method.getName().equals("resolve")) { resolved.incrementAndGet(); stack.poll(); return true; }
            if (method.getName().equals("equals")) return proxy == args[0];
            return null;
        });
        stack.add(object);
        stack.resolve(game);
        assertEquals(1, resolved.get());
        assertNull(feed.sequenceEvidence());
    }

    @Test public void simulatedStackResolutionDoesNotPublishEvidence() {
        StackObject object = (StackObject) Proxy.newProxyInstance(StackObject.class.getClassLoader(), new Class<?>[]{StackObject.class}, (proxy, method, args) -> {
            if (method.getName().equals("getId")) return stackId;
            if (method.getName().equals("resolve")) { stack.poll(); return true; }
            if (method.getName().equals("equals")) return proxy == args[0];
            return null;
        });
        stack.add(object);
        stack.resolve(stub(Game.class, values("getId", gameId, "isSimulation", true)));
        assertEquals(0, feed.sequenceEvidence().getResolutionRevision());
        assertTrue(feed.sequenceEvidence().getPublicActions().isEmpty());
    }
}
