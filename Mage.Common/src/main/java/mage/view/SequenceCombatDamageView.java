package mage.view;

import java.io.Serializable;
import java.util.UUID;

/** Already-public combat damage to a player; no choices, hidden identities or random outcomes. */
public final class SequenceCombatDamageView implements Serializable {
    private static final long serialVersionUID = 1L;
    private final long revision;
    private final UUID sourceId, controllerId, targetId;
    private final int amount;

    public SequenceCombatDamageView(long revision, UUID sourceId, UUID controllerId, UUID targetId, int amount) {
        this.revision = revision; this.sourceId = sourceId; this.controllerId = controllerId; this.targetId = targetId; this.amount = amount;
    }
    public long getRevision() { return revision; }
    public UUID getSourceId() { return sourceId; }
    public UUID getControllerId() { return controllerId; }
    public UUID getTargetId() { return targetId; }
    public int getAmount() { return amount; }
}
