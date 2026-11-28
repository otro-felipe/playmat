package mage.server.game;

import com.google.gson.Gson;
import com.google.gson.JsonObject;
import mage.abilities.Ability;
import mage.cards.Card;
import mage.cards.CardSetInfo;
import mage.cards.m.MonasterySwiftspear;
import mage.constants.Rarity;
import mage.constants.PhaseStep;
import mage.constants.Zone;
import mage.game.Game;
import mage.game.GameImpl;
import mage.game.combat.CombatGroup;
import mage.game.match.MatchType;
import mage.game.mulligan.LondonMulligan;
import mage.constants.MultiplayerAttackOption;
import mage.constants.RangeOfInfluence;
import mage.game.GameState;
import mage.game.events.GameEvent;
import mage.game.events.ZoneChangeEvent;
import mage.game.events.DamagedPermanentEvent;
import mage.game.events.DamagedPlayerEvent;
import mage.game.events.DrewCardEvent;
import mage.game.permanent.Permanent;
import mage.game.permanent.PermanentCard;
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
    @Test public void privateDrawAdvancesOnlyItsOwnInformationWitnessWithoutPublicActionOrIdentity() {
        UUID secretCard = UUID.randomUUID();
        recorder.watch(event(GameEvent.EventType.DREW_CARD, secretCard, rival), game);
        recorder.watch(event(GameEvent.EventType.CAST_SPELL, secretCard, rival), game); // attempt, not committed
        String json = new Gson().toJson(feed.sequenceEvidence());
        assertFalse(json.contains(secretCard.toString()));
        assertTrue(feed.sequenceEvidence().getPublicActions().isEmpty());
        assertTrue(feed.sequenceEvidence().getResolutions().isEmpty());
        assertEquals("The drawing player's private witness changes even if that card ID was already known", 1, feed.sequenceEvidence(rival).getInformationRevision());
        assertEquals("Other players cannot observe a private draw counter", 0, feed.sequenceEvidence(own).getInformationRevision());
    }

    @Test public void onlyCommittedCastsAdvanceTheCastingPlayersPublicCounter() {
        UUID spellId = UUID.randomUUID();
        SequenceEvidenceView before = feed.sequenceEvidence(own);
        recorder.watch(event(GameEvent.EventType.CAST_SPELL, spellId, rival), game);
        recorder.watch(event(GameEvent.EventType.LAND_PLAYED, UUID.randomUUID(), rival), game);
        recorder.watch(event(GameEvent.EventType.ACTIVATED_ABILITY, UUID.randomUUID(), rival), game);
        recorder.watch(event(GameEvent.EventType.SPELL_CAST, spellId, rival), game);
        recorder.watch(event(GameEvent.EventType.SPELL_CAST, UUID.randomUUID(), rival), game);
        recorder.watch(event(GameEvent.EventType.SPELL_CAST, UUID.randomUUID(), own), game);

        Gson gson = new Gson();
        JsonObject rivalProjection = gson.toJsonTree(feed.sequenceEvidence(rival)).getAsJsonObject();
        JsonObject observerProjection = gson.toJsonTree(feed.sequenceEvidence(own)).getAsJsonObject();
        JsonObject spellCasts = observerProjection.getAsJsonObject("spellCasts");
        assertEquals(2, spellCasts.get(rival.toString()).getAsInt());
        assertEquals(1, spellCasts.get(own.toString()).getAsInt());
        assertEquals(spellCasts, rivalProjection.getAsJsonObject("spellCasts"));
        assertFalse(observerProjection.toString().contains(spellId.toString()));
        assertEquals(Long.valueOf(4), feed.sequenceEvidence(own).getPublicActions().get(rival));
        assertTrue(gson.toJsonTree(before).getAsJsonObject().getAsJsonObject("spellCasts").isEmpty());
    }

    @Test public void combatPublishesOneWitnessOnlyAfterACompletedNonemptyDeclaration() {
        ResolvingGame live = new ResolvingGame(false);
        GameEventFeed liveFeed = GameEventFeed.open(live.getId());
        try {
            live.getState().addWatcher(new GameEventRecorder(live.getId()));
            live.getCombat().setAttacker(rival);
            live.getCombat().resumeSelectAttackers(live);
            live.getState().handleSimultaneousEvent(live);
            Gson gson = new Gson();
            assertTrue(gson.toJsonTree(liveFeed.sequenceEvidence(own)).getAsJsonObject()
                    .getAsJsonObject("attackerDeclarations").isEmpty());

            CombatGroup group = new CombatGroup(own, false, own);
            live.getCombat().getGroups().add(group);
            for (int i = 0; i < 2; i++) {
                Card card = new MonasterySwiftspear(rival, new CardSetInfo("Monastery Swiftspear", "KTK", "118", Rarity.UNCOMMON));
                Permanent permanent = new PermanentCard(card, rival, live);
                live.getState().getBattlefield().addPermanent(permanent);
                group.getAttackers().add(permanent.getId());
            }
            live.getCombat().resumeSelectAttackers(live);
            assertTrue(gson.toJsonTree(liveFeed.sequenceEvidence(own)).getAsJsonObject()
                    .getAsJsonObject("attackerDeclarations").isEmpty());
            live.getState().handleSimultaneousEvent(live);
            JsonObject committed = gson.toJsonTree(liveFeed.sequenceEvidence(own)).getAsJsonObject();
            assertEquals(1, committed.getAsJsonObject("attackerDeclarations").get(rival.toString()).getAsInt());
            assertEquals(Long.valueOf(2), liveFeed.sequenceEvidence(own).getPublicActions().get(rival));
        } finally {
            GameEventFeed.close(live.getId());
        }
    }

    @Test public void ordinaryDrawWitnessBelongsToTheActiveDrawingSeatAndIsClearedByRollback() {
        Gson gson = new Gson();
        UUID drawnCard = UUID.randomUUID();
        Game drawStep = stub(Game.class, values("getId", gameId, "isSimulation", false,
                "getTurnStepType", PhaseStep.DRAW, "getActivePlayerId", own, "getTurnNum", 5));
        recorder.watch(event(GameEvent.EventType.DREW_CARD, drawnCard, own), game);
        recorder.watch(event(GameEvent.EventType.DREW_CARD, drawnCard, rival), drawStep);
        Ability source = stub(Ability.class, values("getSourceId", UUID.randomUUID()));
        recorder.watch(new DrewCardEvent(drawnCard, own, source, null), drawStep);
        assertEquals(0, gson.toJsonTree(feed.sequenceEvidence(own)).getAsJsonObject().get("lastDrawTurn").getAsInt());
        recorder.watch(event(GameEvent.EventType.DREW_CARD, drawnCard, own), drawStep);
        JsonObject ownProjection = gson.toJsonTree(feed.sequenceEvidence(own)).getAsJsonObject();
        assertEquals(5, ownProjection.get("lastDrawTurn").getAsInt());
        assertFalse(ownProjection.toString().contains(drawnCard.toString()));
        assertEquals(0, gson.toJsonTree(feed.sequenceEvidence(rival)).getAsJsonObject().get("lastDrawTurn").getAsInt());
        assertFalse(gson.toJsonTree(feed.sequenceEvidence()).getAsJsonObject().has("lastDrawTurn"));

        feed.rollbackTo(6);
        assertEquals(5, gson.toJsonTree(feed.sequenceEvidence(own)).getAsJsonObject().get("lastDrawTurn").getAsInt());
        feed.rollbackTo(5);
        assertEquals(0, gson.toJsonTree(feed.sequenceEvidence(own)).getAsJsonObject().get("lastDrawTurn").getAsInt());
        assertEquals(3, feed.sequenceEvidence(own).getInformationRevision());
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

    @Test public void publicCombatDamageHasExactSourceControllerTargetAndAmountWithoutInventingAnAction() {
        UUID attackerId = UUID.randomUUID();
        Permanent attacker = stub(Permanent.class, values("getId", attackerId, "getControllerId", own));
        Game combatGame = stub(Game.class, values("getId", gameId, "isSimulation", false, "getPermanentOrLKIBattlefield", attacker));
        recorder.watch(new DamagedPlayerEvent(rival, attackerId, rival, 3, true), combatGame);
        SequenceEvidenceView evidence = feed.sequenceEvidence(own);
        assertEquals(1, evidence.getCombatRevision());
        assertEquals(attackerId, evidence.getCombatDamage().get(0).getSourceId());
        assertEquals(own, evidence.getCombatDamage().get(0).getControllerId());
        assertEquals(rival, evidence.getCombatDamage().get(0).getTargetId());
        assertEquals(3, evidence.getCombatDamage().get(0).getAmount());
        assertFalse(evidence.getCombatDamage().get(0).isTargetPermanent());
        assertTrue(evidence.getPublicActions().isEmpty());
    }

    @Test public void publicCombatDamageToPermanentsDistinguishesItsTargetFromPlayerLife() {
        UUID attackerId = UUID.randomUUID(), blockerId = UUID.randomUUID();
        Permanent attacker = stub(Permanent.class, values("getId", attackerId, "getControllerId", own));
        Game combatGame = stub(Game.class, values("getId", gameId, "isSimulation", false, "getPermanentOrLKIBattlefield", attacker));
        recorder.watch(new DamagedPermanentEvent(blockerId, attackerId, rival, 2, false), combatGame);
        recorder.watch(new DamagedPermanentEvent(blockerId, attackerId, rival, 4, true), combatGame);
        SequenceEvidenceView evidence = feed.sequenceEvidence(own);
        assertEquals(1, evidence.getCombatRevision());
        assertEquals(attackerId, evidence.getCombatDamage().get(0).getSourceId());
        assertEquals(blockerId, evidence.getCombatDamage().get(0).getTargetId());
        assertEquals(4, evidence.getCombatDamage().get(0).getAmount());
        assertTrue(evidence.getCombatDamage().get(0).isTargetPermanent());
        assertTrue(evidence.getPublicActions().isEmpty());
    }

    @Test public void publicDeathReplacementAttestsOnlyTheExactRecentPermanentHit() {
        UUID target = UUID.randomUUID();
        Permanent creature = stub(Permanent.class, values("getId", target));
        Card visibleCard = stub(Card.class, values("getId", target));
        Game combatGame = stub(Game.class, values("getId", gameId, "getCard", visibleCard));
        ZoneChangeEvent exile = new ZoneChangeEvent(creature, null, rival, Zone.BATTLEFIELD, Zone.GRAVEYARD);
        exile.setToZone(Zone.EXILED);
        recorder.watch(exile, combatGame);
        assertTrue(feed.sequenceEvidence().getCombatExileReplacements().isEmpty());

        feed.combatDamage(stackId, own, target, 3, true);
        feed.combatDamage(stackId, own, rival, 2, false);
        SequenceEvidenceView before = feed.sequenceEvidence();
        recorder.watch(new ZoneChangeEvent(creature, null, rival, Zone.BATTLEFIELD, Zone.EXILED), combatGame);
        assertTrue(feed.sequenceEvidence().getCombatExileReplacements().isEmpty());
        // Leaving and returning creates a different permanent even if XMage reuses the UUID.
        recorder.watch(exile, combatGame);
        assertTrue(feed.sequenceEvidence().getCombatExileReplacements().isEmpty());
        feed.combatDamage(stackId, own, target, 3, true);
        Game hiddenCard = stub(Game.class, values("getId", gameId, "getCard", stub(Card.class, values("isFaceDown", true))));
        recorder.watch(exile, hiddenCard);
        assertTrue(feed.sequenceEvidence().getCombatExileReplacements().isEmpty());
        feed.combatDamage(stackId, own, target, 3, true);
        Permanent faceDown = stub(Permanent.class, values("getId", target, "isFaceDown", true));
        ZoneChangeEvent hiddenDeath = new ZoneChangeEvent(faceDown, null, rival, Zone.BATTLEFIELD, Zone.GRAVEYARD);
        hiddenDeath.setToZone(Zone.EXILED);
        recorder.watch(hiddenDeath, combatGame);
        assertTrue(feed.sequenceEvidence().getCombatExileReplacements().isEmpty());

        feed.combatDamage(stackId, own, target, 3, true);
        recorder.watch(exile, combatGame);
        assertEquals(Long.valueOf(5), feed.sequenceEvidence().getCombatExileReplacements().get(target));
        assertTrue(before.getCombatExileReplacements().isEmpty());
        for (int i = 0; i < GameEventFeed.RESOLUTION_CAPACITY; i++) feed.combatDamage(stackId, own, rival, 1, false);
        assertTrue(feed.sequenceEvidence().getCombatExileReplacements().isEmpty());
    }

    @Test public void nonCombatOrUnknownSourceCannotSupplyAnOwnCombatWitness() {
        recorder.watch(new DamagedPlayerEvent(rival, UUID.randomUUID(), rival, 3, false), game);
        recorder.watch(new DamagedPlayerEvent(rival, UUID.randomUUID(), rival, 3, true), game);
        assertEquals(0, feed.sequenceEvidence().getCombatRevision());
        assertTrue(feed.sequenceEvidence().getCombatDamage().isEmpty());
    }

    @Test public void randomInformationCounterIsOwnViewerOnlyAndContainsNoResultOrSourceIdentity() {
        UUID privateSource = UUID.randomUUID();
        SequenceEvidenceView before = feed.sequenceEvidence(own);
        GameEvent random = new GameEvent(GameEvent.EventType.COIN_FLIPPED, own, (Ability) null, own) { { setSourceId(privateSource); } };
        recorder.watch(random, game);
        assertEquals(0, before.getInformationRevision());
        assertEquals(1, feed.sequenceEvidence(own).getInformationRevision());
        assertEquals(0, feed.sequenceEvidence(rival).getInformationRevision());
        assertEquals(0, feed.sequenceEvidence().getInformationRevision());
        assertFalse(new Gson().toJson(feed.sequenceEvidence(own)).contains(privateSource.toString()));
    }

    @Test public void boundedCombatHistoryExposesGapsAndDoesNotMutateOldSnapshots() {
        SequenceEvidenceView before = feed.sequenceEvidence(own);
        for (int i = 0; i < GameEventFeed.RESOLUTION_CAPACITY + 2; i++) feed.combatDamage(UUID.randomUUID(), own, rival, 1, false);
        SequenceEvidenceView after = feed.sequenceEvidence(own);
        assertEquals(GameEventFeed.RESOLUTION_CAPACITY, after.getCombatDamage().size());
        assertEquals(GameEventFeed.RESOLUTION_CAPACITY + 2, after.getCombatRevision());
        assertTrue(before.getCombatDamage().isEmpty());
        assertEquals(0, before.getCombatRevision());
    }

    @Test public void publicRandomOriginInvalidatesEveryViewerButPrivateOriginsRemainOwnerOnly() {
        UUID publicSource = UUID.randomUUID();
        GameState publicState = new GameState();
        publicState.setZone(publicSource, Zone.STACK);
        Game publicGame = stub(Game.class, values("getId", gameId, "isSimulation", false, "getState", publicState));
        recorder.watch(new GameEvent(GameEvent.EventType.COIN_FLIPPED, rival, (Ability) null, rival) { { setSourceId(publicSource); } }, publicGame);
        recorder.watch(new GameEvent(GameEvent.EventType.COIN_FLIPPED, rival, (Ability) null, rival) { { setSourceId(UUID.randomUUID()); } }, game);
        assertEquals(1, feed.sequenceEvidence(own).getInformationRevision());
        assertEquals(2, feed.sequenceEvidence(rival).getInformationRevision());
        assertEquals(1, feed.sequenceEvidence().getInformationRevision());
    }

    /** Exercise the live caller, which bypasses SpellStack.resolve entirely. */
    @Test public void liveGameResolutionPublishesEvidenceBeforeEffectsAndSkipsSimulation() {
        for (boolean simulation : new boolean[]{false, true}) {
            ResolvingGame live = new ResolvingGame(simulation);
            GameEventFeed liveFeed = GameEventFeed.open(live.getId());
            AtomicInteger effects = new AtomicInteger();
            try {
                StackObject object = (StackObject) Proxy.newProxyInstance(StackObject.class.getClassLoader(), new Class<?>[]{StackObject.class}, (proxy, method, args) -> {
                    if (method.getName().equals("getId")) return stackId;
                    if (method.getName().equals("resolve")) {
                        assertEquals("The live caller must witness the public stack object before its effect", simulation ? null : Long.valueOf(1), liveFeed.sequenceEvidence().getResolutions().get(stackId));
                        effects.incrementAndGet();
                        live.getStack().poll();
                        return true;
                    }
                    if (method.getName().equals("equals")) return proxy == args[0];
                    return null;
                });
                live.getStack().add(object);
                live.resolveTop();
                assertEquals(1, effects.get());
                assertEquals(simulation ? 0 : 1, liveFeed.sequenceEvidence().getResolutionRevision());
                assertTrue(liveFeed.sequenceEvidence().getPublicActions().isEmpty());
            } finally { GameEventFeed.close(live.getId()); }
        }
    }

    private static final class ResolvingGame extends GameImpl {
        ResolvingGame(boolean simulate) { super(MultiplayerAttackOption.MULTIPLE, RangeOfInfluence.ALL, new LondonMulligan(0), 60, 20, 7); simulation = simulate; }
        void resolveTop() { super.resolve(); }
        @Override public MatchType getGameType() { return null; }
        @Override public int getNumPlayers() { return 2; }
        @Override public Game copy() { throw new UnsupportedOperationException("No simulation copies in this caller regression"); }
        @Override public void resetControlAfterSpellResolve(UUID id) { }
        @Override protected void checkInfiniteLoop(UUID id) { }
    }
}
