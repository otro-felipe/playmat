package mage.cards.decks;

import org.junit.Test;

import java.util.Collections;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

public class LibraryDeckSelectionTest {
    @Test
    public void retainsSelectedListAcrossLoadingAndCopiesWithoutPublishingItInDeckExports() throws Exception {
        DeckCardLists submission = new DeckCardLists();
        submission.setLibraryDeckId("my-list");
        Deck deck = Deck.load(submission.copy(), false, false, Collections.emptyMap());
        assertEquals("my-list", deck.copy().getLibraryDeckId());
        assertNull(deck.prepareCardsOnlyDeck().getLibraryDeckId());
    }
}
