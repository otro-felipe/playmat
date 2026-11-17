package mage.view;

import java.io.Serializable;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;

/** Public actions and recent public stack resolutions, never private choices or card identities. */
public final class SequenceEvidenceView implements Serializable {
    private static final long serialVersionUID = 1L;
    private final String epoch;
    private final Map<UUID, Long> publicActions;
    private final Map<UUID, Long> resolutions;
    private final long resolutionRevision;

    public SequenceEvidenceView(String epoch, Map<UUID, Long> publicActions,
            Map<UUID, Long> resolutions, long resolutionRevision) {
        this.epoch = epoch;
        this.publicActions = new LinkedHashMap<>(publicActions);
        this.resolutions = new LinkedHashMap<>(resolutions);
        this.resolutionRevision = resolutionRevision;
    }
    public String getEpoch() { return epoch; }
    public Map<UUID, Long> getPublicActions() { return publicActions; }
    public Map<UUID, Long> getResolutions() { return resolutions; }
    public long getResolutionRevision() { return resolutionRevision; }
}
