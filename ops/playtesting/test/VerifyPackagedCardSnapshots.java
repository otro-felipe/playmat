import mage.cards.Card;
import mage.cards.CardSetInfo;
import mage.cards.s.SeverancePriest;
import mage.cards.s.SkyclaveApparition;
import mage.constants.Rarity;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.ObjectInputStream;
import java.io.ObjectOutputStream;
import java.util.UUID;

/** Exercise the card constructors and snapshot serialization using only the packaged server classpath. */
class VerifyPackagedCardSnapshots {
    public static void main(String[] args) throws Exception {
        UUID owner = UUID.randomUUID();
        CardSetInfo info = new CardSetInfo("Snapshot fixture", "TST", "1", Rarity.RARE);
        verify(new SkyclaveApparition(owner, info));
        verify(new SeverancePriest(owner, info));
    }

    private static void verify(Card card) throws Exception {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        try (ObjectOutputStream out = new ObjectOutputStream(bytes)) {
            out.writeObject(card);
        }
        try (ObjectInputStream in = new ObjectInputStream(new ByteArrayInputStream(bytes.toByteArray()))) {
            Card restored = (Card) in.readObject();
            if (restored.getClass() != card.getClass() || !restored.getId().equals(card.getId())) {
                throw new AssertionError("Card identity changed during the snapshot round trip");
            }
        }
    }
}
