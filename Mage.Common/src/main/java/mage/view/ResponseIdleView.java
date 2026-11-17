package mage.view;

import java.io.Serializable;

/** The receiving player's response-idle timer only; independent of the cumulative match clock. */
public final class ResponseIdleView implements Serializable {
    private static final long serialVersionUID = 1L;
    private final String status;
    private final Long deadlineEpochMs;
    private final long sampledAtEpochMs;
    private final Long remainingMillis;
    private final Long timeoutSeconds;

    public ResponseIdleView(String status, Long deadlineEpochMs, long sampledAtEpochMs,
                            Long remainingMillis, Long timeoutSeconds) {
        this.status = status;
        this.deadlineEpochMs = deadlineEpochMs;
        this.sampledAtEpochMs = sampledAtEpochMs;
        this.remainingMillis = remainingMillis;
        this.timeoutSeconds = timeoutSeconds;
    }

    public String getStatus() { return status; }
    public Long getDeadlineEpochMs() { return deadlineEpochMs; }
    public long getSampledAtEpochMs() { return sampledAtEpochMs; }
    public Long getRemainingMillis() { return remainingMillis; }
    public Long getTimeoutSeconds() { return timeoutSeconds; }
}
