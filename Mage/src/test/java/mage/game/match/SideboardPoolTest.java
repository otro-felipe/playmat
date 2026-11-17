package mage.game.match;

import mage.cards.Card;
import mage.cards.decks.Deck;
import mage.players.Player;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.lang.reflect.Proxy;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertTrue;

class SideboardPoolTest {

    @Test
    @DisplayName("[PM-AC-06] Invalid autosave leaves the registered list intact")
    void rejectsAReplacementWithoutChangingTheDeck() {
        Card registered = namedCard("Registered");
        Card sideboard = namedCard("Sideboard");
        Deck initial = deck(registered, sideboard);
        MatchPlayer seat = seat(initial);
        seat.setSideboarding();

        assertFalse(seat.updateDeck(deck(namedCard("Other legal card"), sideboard), false));
        assertSame(initial, seat.getDeck());
        assertFalse(seat.isDoneSideboarding());
    }

    @Test
    @DisplayName("[PM-AC-06] Sideboarding can exchange cards from the registered pool")
    void acceptsASwapWithinThePool() {
        Card registered = namedCard("Registered");
        Card sideboard = namedCard("Sideboard");
        MatchPlayer seat = seat(deck(registered, sideboard));
        seat.setSideboarding();
        Deck swapped = deck(sideboard, registered);

        assertTrue(seat.updateDeck(swapped, false));
        assertSame(swapped, seat.getDeck());
        assertFalse(seat.isDoneSideboarding());
    }

    private static MatchPlayer seat(Deck deck) {
        Player player = stub(Player.class, "getName", "Tester");
        Match match = stub(Match.class, "getWinsNeeded", 2);
        return new MatchPlayer(player, deck, match);
    }

    private static Deck deck(Card main, Card sideboard) {
        Deck deck = new Deck();
        deck.getCards().add(main);
        deck.getSideboard().add(sideboard);
        return deck;
    }

    private static Card namedCard(String name) {
        return stub(Card.class, "getName", name);
    }

    private static <T> T stub(Class<T> type, String getter, Object value) {
        return type.cast(Proxy.newProxyInstance(type.getClassLoader(), new Class<?>[]{type}, (proxy, method, arguments) -> {
            switch (method.getName()) {
                case "hashCode":
                    return System.identityHashCode(proxy);
                case "equals":
                    return proxy == arguments[0];
                default:
                    if (getter.equals(method.getName())) {
                        return value;
                    }
                    throw new UnsupportedOperationException(method.getName());
            }
        }));
    }
}
