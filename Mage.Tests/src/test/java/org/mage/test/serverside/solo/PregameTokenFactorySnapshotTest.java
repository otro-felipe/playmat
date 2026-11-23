package org.mage.test.serverside.solo;

import mage.cards.Card;
import mage.cards.CardSetInfo;
import mage.cards.s.SeverancePriest;
import mage.cards.s.SkyclaveApparition;
import mage.constants.Rarity;
import mage.game.GameSnapshot;
import mage.game.GameState;
import org.junit.Test;

import java.util.Arrays;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotSame;

public class PregameTokenFactorySnapshotTest {
    @Test
    public void decksWithBothExileTokenFactoriesCanBeSavedAndRestoredBeforePlay() {
        UUID owner = UUID.randomUUID();
        Map<UUID, Card> deck = new LinkedHashMap<>();
        for (Card card : Arrays.asList(
                new SkyclaveApparition(owner, new CardSetInfo("Skyclave Apparition", "ZNR", "39", Rarity.RARE)),
                new SeverancePriest(owner, new CardSetInfo("Severance Priest", "TDM", "220", Rarity.UNCOMMON)))) {
            deck.put(card.getId(), card);
        }
        GameSnapshot.Restored restored = GameSnapshot.of(new GameState(), deck, Collections.emptyMap(), null).restore();
        assertEquals(deck.keySet(), restored.gameCards.keySet());
        deck.forEach((id, original) -> {
            Card copy = restored.gameCards.get(id);
            assertNotSame(original, copy);
            assertEquals(original.getClass(), copy.getClass());
            assertEquals(original.getRules(), copy.getRules());
        });
    }
}
