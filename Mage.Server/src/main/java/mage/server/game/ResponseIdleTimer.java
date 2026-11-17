package mage.server.game;

import mage.view.ResponseIdleView;

import java.util.UUID;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.function.LongSupplier;
import java.util.function.LongConsumer;

/** Owns one pending response. Reads never rearm it, and cancelled callbacks cannot expire a later prompt. */
final class ResponseIdleTimer {
    private final ScheduledExecutorService executor;
    private final LongSupplier now;
    private ScheduledFuture<?> future;
    private UUID playerId;
    private long timeoutSeconds;
    private long generation;
    private long deadlineEpochMs;
    private long expiredGeneration = -1;

    ResponseIdleTimer(ScheduledExecutorService executor, LongSupplier now) {
        this.executor = executor;
        this.now = now;
    }

    synchronized ScheduledFuture<?> start(UUID player, long seconds, LongConsumer expire) {
        cancel();
        playerId = player;
        timeoutSeconds = seconds;
        final long current = generation;
        future = executor.schedule(() -> {
            synchronized (ResponseIdleTimer.this) {
                if (current != generation || !player.equals(playerId)) return;
                playerId = null;
                expiredGeneration = current;
            }
            // Do not call the game while holding the timer lock. The game-thread action revalidates this claim.
            expire.accept(current);
        }, seconds, TimeUnit.SECONDS);
        deadlineEpochMs = now.getAsLong() + Math.max(0, future.getDelay(TimeUnit.MILLISECONDS));
        return future;
    }

    synchronized boolean isExpired(long expectedGeneration) {
        return generation == expectedGeneration && expiredGeneration == expectedGeneration;
    }

    synchronized void cancel() {
        generation++;
        if (future != null) future.cancel(false);
        playerId = null;
    }

    synchronized ResponseIdleView view(UUID recipient, boolean enabled) {
        long sampled = now.getAsLong();
        if (!enabled) return new ResponseIdleView("disabled", null, sampled, null, null);
        if (future == null || playerId == null || !playerId.equals(recipient) || future.isCancelled() || future.isDone()) {
            return new ResponseIdleView("inactive", null, sampled, null, null);
        }
        long remaining = Math.max(0, future.getDelay(TimeUnit.MILLISECONDS));
        return new ResponseIdleView("running", deadlineEpochMs, sampled, remaining, timeoutSeconds);
    }
}
