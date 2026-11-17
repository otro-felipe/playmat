package mage.server.game;

import mage.view.ResponseIdleView;
import org.junit.jupiter.api.Test;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import static org.junit.jupiter.api.Assertions.*;

class ResponseIdleTimerTest {
    private static final class FakeExecutor extends ScheduledThreadPoolExecutor {
        final List<Runnable> callbacks = new ArrayList<>();
        final AtomicLong left = new AtomicLong();
        FakeExecutor() { super(1); }
        @Override public ScheduledFuture<?> schedule(Runnable command, long delay, TimeUnit unit) {
            callbacks.add(command); left.set(unit.toMillis(delay));
            return new ScheduledFuture<Object>() {
                boolean cancelled;
                public long getDelay(TimeUnit target) { return target.convert(left.get(), TimeUnit.MILLISECONDS); }
                public int compareTo(Delayed other) { return 0; }
                public boolean cancel(boolean interrupt) { cancelled = true; return true; }
                public boolean isCancelled() { return cancelled; }
                public boolean isDone() { return false; }
                public Object get() { return null; }
                public Object get(long n, TimeUnit u) { return null; }
            };
        }
    }

    @Test void pollingCannotRenewAndOtherSeatsNeverSeeThePendingDeadline() {
        FakeExecutor executor = new FakeExecutor();
        AtomicLong now = new AtomicLong(10_000);
        ResponseIdleTimer timer = new ResponseIdleTimer(executor, now::get);
        UUID player = UUID.randomUUID(); AtomicInteger expired = new AtomicInteger();
        timer.start(player, 900, ignored -> expired.incrementAndGet());
        ResponseIdleView first = timer.view(player, true);
        assertEquals(910_000L, first.getDeadlineEpochMs().longValue());
        assertEquals(900_000L, first.getRemainingMillis().longValue());
        now.addAndGet(5_000); executor.left.addAndGet(-5_000);
        for (int n = 0; n < 50; n++) {
            assertEquals(910_000L, timer.view(player, true).getDeadlineEpochMs().longValue());
            assertEquals(895_000L, timer.view(player, true).getRemainingMillis().longValue());
            assertNull(timer.view(UUID.randomUUID(), true).getDeadlineEpochMs());
        }
        assertEquals(1, executor.callbacks.size());
        assertEquals(0, expired.get());
        executor.shutdownNow();
    }

    @Test void acceptedResponseCancelsAndTheNextPromptGetsANewFullWindow() {
        FakeExecutor executor = new FakeExecutor();
        AtomicLong now = new AtomicLong(10_000);
        ResponseIdleTimer timer = new ResponseIdleTimer(executor, now::get);
        UUID player = UUID.randomUUID(); AtomicInteger expired = new AtomicInteger();
        timer.start(player, 60, ignored -> expired.incrementAndGet());
        Runnable stale = executor.callbacks.get(0);
        timer.cancel();
        assertEquals("inactive", timer.view(player, true).getStatus());
        now.addAndGet(20_000);
        timer.start(player, 60, ignored -> expired.incrementAndGet());
        stale.run();
        assertEquals(0, expired.get());
        assertEquals(90_000L, timer.view(player, true).getDeadlineEpochMs().longValue());
        executor.left.set(0);
        assertEquals(0L, timer.view(player, true).getRemainingMillis().longValue());
        executor.callbacks.get(1).run();
        assertEquals(1, expired.get());
        assertEquals("inactive", timer.view(player, true).getStatus());
        assertEquals("disabled", timer.view(player, false).getStatus());
        executor.shutdownNow();
    }
    @Test void aQueuedExpiryCannotConcedeAfterAnAcceptedResponseOrNewPrompt() {
        FakeExecutor executor = new FakeExecutor();
        ResponseIdleTimer timer = new ResponseIdleTimer(executor, () -> 1000L);
        UUID player = UUID.randomUUID();
        AtomicInteger lost = new AtomicInteger();
        List<Runnable> queuedGameActions = new ArrayList<>();
        timer.start(player, 60, claim -> queuedGameActions.add(() -> {
            if (timer.isExpired(claim)) lost.incrementAndGet();
        }));
        executor.callbacks.get(0).run();
        assertEquals(1, queuedGameActions.size());
        timer.cancel(); // the network accepted a response before the queued expiry could run
        timer.start(player, 60, ignored -> lost.incrementAndGet());
        queuedGameActions.get(0).run();
        assertEquals(0, lost.get());
        assertEquals("running", timer.view(player, true).getStatus());
        executor.shutdownNow();
    }

}
