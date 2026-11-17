package mage.server.game;

import com.google.gson.Gson;
import mage.abilities.Ability;
import mage.game.Game;
import mage.game.events.GameEvent;
import mage.game.stack.SpellStack;
import mage.game.stack.StackObject;
import mage.view.SequenceEvidenceView;
import org.junit.After;
import org.junit.Test;

import java.lang.reflect.Proxy;
import java.util.Map;
import java.util.UUID;

import static org.junit.Assert.*;

public class GameEventRecorderEvidenceTest {
    private final UUID gameId = UUID.randomUUID();
    private final UUID own = UUID.randomUUID(), rival = UUID.randomUUID();
    private final UUID stackId = UUID.randomUUID(), abilityId = UUID.randomUUID();
    private final GameEventFeed feed = GameEventFeed.open(gameId);
    private final SpellStack stack = new SpellStack();
    private final Game game = stub(Game.class, Map.of("getId", gameId, "getStack", stack, "isSimulation", false));
    private final GameEventRecorder recorder = new GameEventRecorder(gameId);

    @After public void close() { GameEventFeed.close(gameId); }

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
        Ability ability = stub(Ability.class, Map.of("getOriginalId", abilityId));
        StackObject object = stub(StackObject.class, Map.of("getId", stackId, "getControllerId", own, "getStackAbility", ability));
        stack.add(object);
        recorder.watch(event(GameEvent.EventType.RESOLVING_ABILITY, abilityId, own), game);
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
    @Test public void onlyTheExactPublicStackAbilityCanSupplyResolutionEvidence() {
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
}
