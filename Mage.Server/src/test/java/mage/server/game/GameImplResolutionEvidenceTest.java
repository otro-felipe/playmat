package mage.server.game;

import mage.MageObject;
import mage.abilities.Ability;
import mage.abilities.Mode;
import mage.abilities.effects.OneShotEffect;
import mage.cards.Card;
import mage.cards.CardImpl;
import mage.cards.CardSetInfo;
import mage.cards.l.LightningBolt;
import mage.cards.m.MonasterySwiftspear;
import mage.constants.CardType;
import mage.constants.Outcome;
import mage.constants.Rarity;
import mage.constants.Zone;
import mage.game.FakeGame;
import mage.game.Game;
import mage.game.events.GameEvent;
import mage.game.events.PublicActionObservations;
import mage.game.stack.Spell;
import mage.game.stack.StackObject;
import mage.players.Player;
import org.junit.After;
import org.junit.Test;

import java.lang.reflect.Proxy;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.Assert.*;

/** Enters the actual GameImpl.resolve path; it must not be substituted with SpellStack.resolve in these tests. */
public class GameImplResolutionEvidenceTest {
    private final EntryGame game = new EntryGame();
    private final GameEventFeed feed = GameEventFeed.open(game.getId());
    private final UUID own = UUID.randomUUID(), rival = UUID.randomUUID();
    private final AtomicInteger moves = new AtomicInteger(), damage = new AtomicInteger(), modeEffects = new AtomicInteger();
    private final AtomicInteger abilityEvents = new AtomicInteger();

    private class EntryGame extends FakeGame {
        final Map<UUID, Player> fixturePlayers = new HashMap<>();
        void resolveThroughGameImpl() { super.resolve(); }
        void simulated() { simulation = true; }
        @Override public Player getPlayer(UUID id) { return fixturePlayers.get(id); }
        @Override public void resetControlAfterSpellResolve(UUID id) { }
        @Override protected void checkInfiniteLoop(UUID id) { }
        @Override public void processAction() { }
        @Override public void rememberLKI(Zone zone, MageObject object) { }
        @Override public void fireEvent(GameEvent event) {
            if (event.getType() == GameEvent.EventType.RESOLVING_ABILITY) abilityEvents.incrementAndGet();
            new GameEventRecorder(getId()).watch(event, this);
        }
    }
    @After public void closeFeed() { GameEventFeed.close(game.getId()); }

    private void assertWitnessBeforeEffect() {
        UUID publicStackId = game.getStack().peek().getId();
        assertEquals("Real GameImpl entry must witness before any effect", Long.valueOf(1), feed.sequenceEvidence().getResolutions().get(publicStackId));
        assertEquals(1, feed.sequenceEvidence().getResolutionRevision());
    }
    private Player player(UUID id) {
        return (Player) Proxy.newProxyInstance(Player.class.getClassLoader(), new Class<?>[]{Player.class}, (proxy, method, args) -> {
            switch (method.getName()) {
                case "getId": return id;
                case "getName": return "Synthetic public player";
                case "isInGame": case "canBeTargetedBy": return true;
                case "moveCards":
                    assertWitnessBeforeEffect();
                    moves.incrementAndGet();
                    game.getStack().poll();
                    return true;
                case "damage":
                    assertWitnessBeforeEffect();
                    damage.addAndGet((Integer) args[0]);
                    return args[0];
                default:
                    if (method.getReturnType() == boolean.class) return false;
                    if (method.getReturnType() == int.class) return 0;
                    return null;
            }
        });
    }
    private Spell putOnStack(Card card) {
        game.fixturePlayers.put(own, player(own));
        game.fixturePlayers.put(rival, player(rival));
        Spell spell = new Spell(card, card.getSpellAbility(), own, Zone.HAND, game);
        game.getState().setZone(card.getId(), Zone.STACK);
        game.getStack().add(spell);
        return spell;
    }
    @Test public void realGameImplSwiftspearIsWitnessedBeforePermanentMovement() {
        MonasterySwiftspear card = new MonasterySwiftspear(own, new CardSetInfo("Monastery Swiftspear", "KTK", "118", Rarity.UNCOMMON));
        Spell spell = putOnStack(card);
        game.resolveThroughGameImpl();
        assertEquals(1, moves.get());
        assertEquals(0, abilityEvents.get());
        assertEquals(Long.valueOf(1), feed.sequenceEvidence().getResolutions().get(spell.getId()));
        assertFalse(feed.sequenceEvidence().getResolutions().containsKey(card.getId()));
        assertTrue(game.getStack().isEmpty());
    }
    @Test public void realGameImplBoltIsWitnessedBeforeItsActualDamageEffect() {
        LightningBolt card = new LightningBolt(own, new CardSetInfo("Lightning Bolt", "M10", "146", Rarity.COMMON));
        Spell spell = putOnStack(card);
        spell.getSpellAbility().getTargets().get(0).addTarget(rival, spell.getSpellAbility(), game, true);
        game.resolveThroughGameImpl();
        assertEquals(3, damage.get());
        assertEquals(1, moves.get());
        assertEquals(1, abilityEvents.get());
        assertEquals(1, feed.sequenceEvidence().getResolutionRevision());
        assertEquals(Long.valueOf(1), feed.sequenceEvidence().getResolutions().get(spell.getId()));
    }
    private class EvidenceEffect extends OneShotEffect {
        EvidenceEffect() { super(Outcome.Benefit); }
        @Override public boolean apply(Game current, Ability source) { assertWitnessBeforeEffect(); modeEffects.incrementAndGet(); return true; }
        @Override public EvidenceEffect copy() { return new EvidenceEffect(); }
    }
    private class ModalCard extends CardImpl {
        ModalCard() {
            super(own, new CardSetInfo("Synthetic modal instant", "TST", "1", Rarity.COMMON), new CardType[]{CardType.INSTANT}, "{0}");
            getSpellAbility().addEffect(new EvidenceEffect());
            Mode other = new Mode(new EvidenceEffect());
            getSpellAbility().addMode(other);
            getSpellAbility().getModes().setMinModes(2);
            getSpellAbility().getModes().setMaxModes(2);
            getSpellAbility().getModes().addSelectedMode(other.getId());
        }
        ModalCard(ModalCard other) { super(other); }
        @Override public ModalCard copy() { return new ModalCard(this); }
    }
    @Test public void realGameImplMultipleModesShareOnePublicResolution() {
        Spell spell = putOnStack(new ModalCard());
        game.resolveThroughGameImpl();
        assertEquals(2, modeEffects.get());
        assertEquals(2, abilityEvents.get());
        assertEquals(1, moves.get());
        assertEquals(1, feed.sequenceEvidence().getResolutionRevision());
        assertEquals(Long.valueOf(1), feed.sequenceEvidence().getResolutions().get(spell.getId()));
    }
    private StackObject probe(AtomicInteger resolved) {
        UUID stackId = UUID.randomUUID();
        return (StackObject) Proxy.newProxyInstance(StackObject.class.getClassLoader(), new Class<?>[]{StackObject.class}, (proxy, method, args) -> {
            switch (method.getName()) {
                case "getId": case "getSourceId": return stackId;
                case "getControllerId": return own;
                case "equals": return proxy == args[0];
                case "resolve": resolved.incrementAndGet(); game.getStack().poll(); return true;
                default: return null;
            }
        });
    }
    @Test public void realGameImplSimulationPublishesNoEvidence() {
        AtomicInteger resolved = new AtomicInteger();
        game.simulated();
        game.getStack().add(probe(resolved));
        game.resolveThroughGameImpl();
        assertEquals(1, resolved.get());
        assertEquals(0, feed.sequenceEvidence().getResolutionRevision());
        assertTrue(feed.sequenceEvidence().getPublicActions().isEmpty());
    }
    @Test public void realGameImplObserverFailureCannotPreventResolutionAndFailsEvidenceClosed() {
        PublicActionObservations.close(game.getId());
        PublicActionObservations.register(game.getId(), actor -> { });
        PublicActionObservations.registerResolutions(game.getId(), stackId -> { throw new IllegalStateException("Synthetic observer failure"); });
        AtomicInteger resolved = new AtomicInteger();
        game.getStack().add(probe(resolved));
        game.resolveThroughGameImpl();
        assertEquals(1, resolved.get());
        assertNull(feed.sequenceEvidence());
    }

}
