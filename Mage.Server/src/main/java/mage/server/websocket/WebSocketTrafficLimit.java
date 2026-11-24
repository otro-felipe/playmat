package mage.server.websocket;

import java.util.Arrays;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.TimeUnit;
import java.util.function.LongSupplier;

/** Shared quota for RPCs which allocate games or perform especially expensive work. */
final class WebSocketTrafficLimit {
    private static final long WINDOW = TimeUnit.MINUTES.toNanos(1);
    private static final Set<String> EXPENSIVE = new HashSet<>(Arrays.asList(
            "roomCreateTable", "roomCreateTournament", "matchStart", "tournamentStart",
            "gamePractice", "soloResume", "soloFork", "soloWhatIf", "soloBatchSubmit",
            "gamePuzzleExport", "accountExport", "deckImportFromUrl"));

    private final LongSupplier clock;
    private final int perAccount;
    private final int perInstance;
    private final Map<String, Integer> counts = new HashMap<>();
    private long windowStart;
    private int used;

    WebSocketTrafficLimit(LongSupplier clock, int perAccount, int perInstance) {
        this.clock = clock;
        this.perAccount = perAccount;
        this.perInstance = perInstance;
        this.windowStart = clock.getAsLong();
    }

    boolean allow(String principal, String method) {
        return allow(principal, method, false);
    }

    /** A rate-exempt (administrator) account skips its own budget but still spends the instance budget. */
    boolean allow(String principal, String method, boolean exempt) {
        return !EXPENSIVE.contains(method) || acquire(principal, exempt);
    }

    private synchronized boolean acquire(String principal, boolean exempt) {
        long now = clock.getAsLong();
        if (now - windowStart >= WINDOW) {
            counts.clear();
            used = 0;
            windowStart = now;
        }
        int count = counts.getOrDefault(principal, 0);
        if (used >= perInstance || (!exempt && count >= perAccount)) {
            return false;
        }
        counts.put(principal, count + 1);
        used++;
        return true;
    }
}
