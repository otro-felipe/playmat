package mage.game.match;

import java.io.Serializable;
import java.util.UUID;

/** Issued exclusively by the local tournament coordinator for a two-seat pairing. */
public final class ChampionshipRules implements Serializable {
    private static final long serialVersionUID = 1L;
    public final UUID pairingId;
    public final String seatA;
    public final String seatB;
    public final boolean playoffs;
    private final int firstSideboard;
    public volatile long deadlineAt;
    public volatile String disqualified;
    public String choosingSeat;
    public boolean gamesTiedOnEntry;
    private boolean suddenDeath;

    public void tiedBetweenGames() { suddenDeath = playoffs; }

    public boolean usesLifeTiebreaker() { return playoffs && suddenDeath; }

    public boolean useLifeAtEndOfExtraTurns() {
        if (!playoffs || !gamesTiedOnEntry) return false;
        suddenDeath = true;
        return true;
    }
    private int lastExtraTurn = -1;

    public ChampionshipRules(UUID pairingId, String seatA, String seatB, boolean playoffs, int firstSideboard, long deadlineAt) {
        this.pairingId = pairingId;
        this.seatA = seatA;
        this.choosingSeat = seatA;
        this.seatB = seatB;
        this.playoffs = playoffs;
        this.firstSideboard = firstSideboard;
        this.deadlineAt = deadlineAt;
    }

    public boolean allowsSideboard(int gamesPlayed) { return gamesPlayed >= firstSideboard; }

    public boolean timeCalled(long now) { return deadlineAt > 0 && now >= deadlineAt; }

    /** Called after a turn actually finishes, including extra turns. Skipped turns do not count. */
    public boolean finishedTurn(long now, int turn) {
        if (!timeCalled(now)) return false;
        if (lastExtraTurn < 0) lastExtraTurn = turn + 5;
        return turn >= lastExtraTurn;
    }
}
