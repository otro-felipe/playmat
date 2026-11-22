package mage.view;

import java.io.Serializable;
import java.util.UUID;

/** One already face-up exile, attested only to its owner for this resolution. */
public final class SequenceImpulseExileView implements Serializable {
    private static final long serialVersionUID = 1L;
    private final UUID stackId, sourceId, cardId;
    private final long informationRevision;

    public SequenceImpulseExileView(UUID stackId, UUID sourceId, UUID cardId, long informationRevision) {
        this.stackId = stackId;
        this.sourceId = sourceId;
        this.cardId = cardId;
        this.informationRevision = informationRevision;
    }
    public UUID getStackId() { return stackId; }
    public UUID getSourceId() { return sourceId; }
    public UUID getCardId() { return cardId; }
    public long getInformationRevision() { return informationRevision; }
}
