package mage.server.game;

import java.time.Instant;
import java.util.Collection;
import java.util.HashSet;
import java.util.Set;
import java.util.UUID;

final class RollbackVote {
    final UUID id = UUID.randomUUID();
    final int targetTurn;
    private final int turnAtRequest;
    private final Instant expiresAt;
    private final Set<UUID> awaiting;

    RollbackVote(int turnAtRequest, int targetTurn, Collection<UUID> voters, Instant expiresAt) {
        this.turnAtRequest = turnAtRequest;
        this.targetTurn = targetTurn;
        this.expiresAt = expiresAt;
        this.awaiting = new HashSet<>(voters);
    }

    boolean isOpen(int currentTurn, Instant now) {
        return currentTurn == turnAtRequest && now.isBefore(expiresAt);
    }

    boolean accept(Object requestId, UUID userId, int currentTurn, Instant now) {
        return id.equals(requestId) && isOpen(currentTurn, now) && awaiting.remove(userId);
    }

    boolean isApproved() {
        return awaiting.isEmpty();
    }
}
