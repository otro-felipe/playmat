package mage.view;

import java.io.Serializable;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;
import java.util.List;
import java.util.ArrayList;
import java.util.Collections;

/** Public actions and recent public stack resolutions, never private choices or card identities. */
public final class SequenceEvidenceView implements Serializable {
    private static final long serialVersionUID = 1L;
    private final String epoch;
    private final Map<UUID, Long> publicActions;
    private final Map<UUID, Long> resolutions;
    private final long resolutionRevision;
    private final long combatRevision, informationRevision;
    private final List<SequenceCombatDamageView> combatDamage;
    private final Map<UUID, Long> combatExileReplacements;

    public SequenceEvidenceView(String epoch, Map<UUID, Long> publicActions,
            Map<UUID, Long> resolutions, long resolutionRevision) {
        this(epoch, publicActions, resolutions, resolutionRevision, Collections.emptyList(), 0, 0);
    }

    public SequenceEvidenceView(String epoch, Map<UUID, Long> publicActions, Map<UUID, Long> resolutions,
            long resolutionRevision, List<SequenceCombatDamageView> combatDamage, long combatRevision, long informationRevision) {
        this(epoch, publicActions, resolutions, resolutionRevision, combatDamage, combatRevision, informationRevision, Collections.emptyMap());
    }

    public SequenceEvidenceView(String epoch, Map<UUID, Long> publicActions, Map<UUID, Long> resolutions,
            long resolutionRevision, List<SequenceCombatDamageView> combatDamage, long combatRevision, long informationRevision,
            Map<UUID, Long> combatExileReplacements) {
        this.combatExileReplacements = new LinkedHashMap<>(combatExileReplacements);
        this.epoch = epoch;
        this.publicActions = new LinkedHashMap<>(publicActions);
        this.resolutions = new LinkedHashMap<>(resolutions);
        this.resolutionRevision = resolutionRevision;
        this.combatDamage = new ArrayList<>(combatDamage);
        this.combatRevision = combatRevision;
        this.informationRevision = informationRevision;
    }
    public String getEpoch() { return epoch; }
    public Map<UUID, Long> getPublicActions() { return publicActions; }
    public Map<UUID, Long> getResolutions() { return resolutions; }
    public long getResolutionRevision() { return resolutionRevision; }
    public List<SequenceCombatDamageView> getCombatDamage() { return combatDamage; }
    public long getCombatRevision() { return combatRevision; }
    public Map<UUID, Long> getCombatExileReplacements() { return combatExileReplacements; }
    public long getInformationRevision() { return informationRevision; }
}
