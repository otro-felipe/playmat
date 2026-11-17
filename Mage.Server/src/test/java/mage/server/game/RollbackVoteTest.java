package mage.server.game;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.time.Duration;
import java.time.Instant;
import java.util.Arrays;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.*;

class RollbackVoteTest {
    private final UUID rival = UUID.randomUUID();
    private final UUID otherRival = UUID.randomUUID();
    private final Instant now = Instant.parse("2026-11-16T00:00:00Z");

    @Test
    @DisplayName("[PM-AC-07] A vote cannot move to another turn or approve a newer request")
    void ignoresStaleAndExpiredVotes() {
        RollbackVote vote = new RollbackVote(4, 3, Arrays.asList(rival), now.plusSeconds(30));
        assertFalse(vote.accept(UUID.randomUUID(), rival, 4, now));
        assertFalse(vote.accept(vote.id, UUID.randomUUID(), 4, now));
        assertFalse(vote.accept(vote.id, rival, 5, now));
        assertFalse(vote.accept(vote.id, rival, 4, now.plus(Duration.ofSeconds(30))));
        assertTrue(vote.accept(vote.id, rival, 4, now));
        assertTrue(vote.isApproved());
        assertEquals(3, vote.targetTurn);
    }

    @Test
    @DisplayName("[PM-AC-07] Each eligible seat can vote at most once")
    void requiresEachDistinctSeat() {
        RollbackVote vote = new RollbackVote(4, 4, Arrays.asList(rival, otherRival), now.plusSeconds(30));
        assertTrue(vote.accept(vote.id, rival, 4, now));
        assertFalse(vote.accept(vote.id, rival, 4, now));
        assertFalse(vote.isApproved());
        assertTrue(vote.accept(vote.id, otherRival, 4, now));
        assertTrue(vote.isApproved());
    }
}
