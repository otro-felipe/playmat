import mage.cards.Card;
import mage.cards.repository.CardInfo;
import mage.cards.repository.CardRepository;

import java.nio.file.Path;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.ResultSet;

/** Exercises the shipped executable cards and both catalogs from the assembled XMage image. */
class VerifyPackagedCardCatalog {
    public static void main(String[] args) throws Exception {
        String catalog = Path.of(args[0]).toAbsolutePath().toUri().toString();
        try (Connection db = DriverManager.getConnection("jdbc:sqlite:" + catalog + "?mode=ro");
             PreparedStatement printing = db.prepareStatement(
                     "SELECT p.name FROM exact e JOIN printings p ON p.id = e.printing"
                     + " JOIN format_sets f ON f.set_code = p.set_code"
                     + " WHERE lower(f.format) = 'constructed - pioneer' AND e.set_code = 'fra' AND e.card_number = ?")) {
            verify(printing, "223", "Way of the Cryomancer");
            verify(printing, "159", "Uldaros Theorix");
            verify(printing, "38", "Seasoned Cryomancer");
        }
    }

    private static void verify(PreparedStatement printing, String cardNumber, String name) throws Exception {
        CardInfo info = CardRepository.instance.findCard("FRA", cardNumber);
        if (info == null || !name.equals(info.getName())) {
            throw new AssertionError("[PM-CATALOG-AC-01] Missing H2 entry for " + name + " (FRA " + cardNumber + ")");
        }
        Card card = info.createCard();
        if (card == null || !name.equals(card.getName()) || card.getRules().isEmpty()) {
            throw new AssertionError("[PM-CATALOG-AC-01] Cannot instantiate the rules for " + name);
        }

        printing.setString(1, cardNumber);
        try (ResultSet row = printing.executeQuery()) {
            if (!row.next() || !name.equals(row.getString(1))) {
                throw new AssertionError("[PM-CATALOG-AC-01] Missing SQLite Pioneer printing for " + name);
            }
        }
    }
}
