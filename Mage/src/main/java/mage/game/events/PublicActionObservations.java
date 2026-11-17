package mage.game.events;

import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.Consumer;

/**
 * Server observation of committed public actions which have no rules event (mana/no-stack activations).
 * This is deliberately not a GameEvent: observing an action must never create triggers or replacement effects.
 * No card, selected option, private prompt, or attempt is carried here. Runtime observers are not game state,
 * so undo/copying a state cannot erase a public action that already occurred.
 */
public final class PublicActionObservations {
    private static final Map<UUID, Consumer<UUID>> OBSERVERS = new ConcurrentHashMap<>();
    private PublicActionObservations() { }

    public static void register(UUID gameId, Consumer<UUID> observer) { OBSERVERS.putIfAbsent(gameId, observer); }
    public static void close(UUID gameId) { if (gameId != null) OBSERVERS.remove(gameId); }
    public static boolean isObserved(UUID gameId) { return OBSERVERS.containsKey(gameId); }

    public static void accepted(UUID gameId, UUID publicActorId) {
        Consumer<UUID> observer = OBSERVERS.get(gameId);
        if (observer == null || publicActorId == null) return;
        try { observer.accept(publicActorId); }
        catch (RuntimeException failedObserver) {
            // Observation cannot change game rules. Removing it makes evidence unavailable to guarded clients.
            OBSERVERS.remove(gameId, observer);
        }
    }
}
