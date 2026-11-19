package mage.game.trace;

import mage.abilities.Ability;
import mage.cards.Card;
import mage.game.Game;
import mage.players.Player;

import java.util.ArrayList;
import java.util.Collection;
import java.util.Collections;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentMap;
import java.util.function.Consumer;
import java.util.function.Supplier;
import java.util.logging.Level;
import java.util.logging.Logger;

/**
 * A committed decision for a protected replay. Observers are attached only to the live game instance, never
 * copied into simulations or recovery snapshots. These decisions do not enter the rules event stream.
 */
public final class ReplayDecision {

    public enum Kind { KEEP, MULLIGAN, SELECT, PASS }
    public enum PassKind { MANUAL, AUTOMATIC }
    public enum ChoiceKind { DISCARD, BOTTOM }

    private static final Logger LOGGER = Logger.getLogger(ReplayDecision.class.getName());
    private static final ConcurrentMap<UUID, Observer> OBSERVERS = new ConcurrentHashMap<>();

    public final Kind kind;
    public final UUID actorId;
    public final UUID chooserId;
    public final UUID sourceId;
    public final UUID affectedPlayerId;
    public final List<Card> cards;
    public final List<UUID> selectedIds;
    public final PassKind passKind;
    public final ChoiceKind choiceKind;

    private ReplayDecision(Kind kind, UUID actorId, UUID chooserId, UUID sourceId, UUID affectedPlayerId,
                           Collection<? extends Card> cards, Collection<UUID> selectedIds, PassKind passKind,
                           ChoiceKind choiceKind) {
        this.kind = kind;
        this.actorId = actorId;
        this.chooserId = chooserId;
        this.sourceId = sourceId;
        this.affectedPlayerId = affectedPlayerId;
        this.cards = Collections.unmodifiableList(new ArrayList<>(cards));
        this.selectedIds = Collections.unmodifiableList(new ArrayList<>(selectedIds));
        this.passKind = passKind;
        this.choiceKind = choiceKind;
    }

    public interface Subscription extends AutoCloseable {
        @Override
        void close();
    }

    private static final class Observer {
        final Game game;
        final Consumer<ReplayDecision> consumer;

        Observer(Game game, Consumer<ReplayDecision> consumer) {
            this.game = game;
            this.consumer = consumer;
        }
    }

    public static Subscription observe(Game game, Consumer<ReplayDecision> consumer) {
        Observer observer = new Observer(game, consumer);
        OBSERVERS.put(game.getId(), observer);
        return () -> OBSERVERS.remove(game.getId(), observer);
    }

    private static void emit(Game game, Supplier<ReplayDecision> decision) {
        Observer observer = OBSERVERS.get(game.getId());
        if (observer == null || observer.game != game || game.isSimulation() || game.hasEnded()) {
            return;
        }
        try {
            observer.consumer.accept(decision.get());
        } catch (RuntimeException error) {
            // Capture must never change a committed play or log private decision contents.
            LOGGER.log(Level.WARNING, "Protected replay decision capture failed for game {0}", game.getId());
        }
    }

    public static void openingHand(Game game, Player player, boolean mulligan) {
        emit(game, () -> new ReplayDecision(mulligan ? Kind.MULLIGAN : Kind.KEEP, player.getId(), player.getId(),
                null, null, player.getHand().getCards(game), Collections.emptyList(), null, null));
    }

    public static void discardChoice(Game game, Player chooser, Player affected, Ability source,
                                     Supplier<? extends Collection<Card>> availableCards, Collection<UUID> selectedIds) {
        emit(game, () -> new ReplayDecision(Kind.SELECT, chooser.getId(), chooser.getId(), source.getSourceId(),
                affected.getId(), availableCards.get(), selectedIds, null, ChoiceKind.DISCARD));
    }

    public static void mulliganBottom(Game game, Player player, Collection<UUID> selectedIds) {
        if (!selectedIds.isEmpty()) {
            emit(game, () -> new ReplayDecision(Kind.SELECT, player.getId(), player.getId(), null, player.getId(),
                    player.getHand().getCards(game), selectedIds, null, ChoiceKind.BOTTOM));
        }
    }

    public static void priorityPass(Game game, Player player, PassKind kind) {
        emit(game, () -> new ReplayDecision(Kind.PASS, player.getId(), player.getTurnControlledBy(), null, null,
                Collections.emptyList(), Collections.emptyList(), kind, null));
    }
}
