package mage.server.recovery;

import mage.cards.decks.DeckCardLists;
import mage.game.GameSnapshot;
import mage.game.match.Match;
import mage.game.match.MatchOptions;
import mage.game.match.MatchPlayer;
import mage.players.Player;

import java.io.*;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/** Private match configuration accompanying exactly one turn snapshot. Not an authorization record. */
final class CheckpointContext implements Serializable {
    private static final long serialVersionUID = 1L;
    final UUID matchId;
    final UUID tableId;
    final UUID gameId;
    final int gameNumber;
    final int draws;
    final MatchOptions options;
    final List<Seat> seats = new ArrayList<>();

    CheckpointContext(UUID tableId, Match match, Map<UUID, UUID> users, GameSnapshot snapshot) throws IOException {
        this.matchId = match.getId();
        this.tableId = tableId;
        this.gameId = match.getGame().getId();
        this.gameNumber = match.getNumGames();
        this.draws = match.getDraws();
        try {
            // Copy before redaction: never mutate the live table's password/configuration.
            this.options = (MatchOptions) read(bytes(match.getOptions()));
        } catch (ClassNotFoundException e) {
            throw new IOException("Cannot copy checkpoint configuration", e);
        }
        options.setPassword("");
        GameSnapshot.Restored frozen = snapshot.restore();
        for (MatchPlayer player : match.getPlayers()) {
            Player atTurn = frozen.state.getPlayer(player.getPlayer().getId());
            UUID user = users.entrySet().stream()
                    .filter(e -> e.getValue().equals(player.getPlayer().getId()))
                    .map(Map.Entry::getKey).findFirst().orElse(null);
            if (atTurn == null || user == null || player.getDeck() == null) {
                throw new IOException("Checkpoint seat is incomplete");
            }
            seats.add(new Seat(user, player, atTurn));
        }
    }

    static final class Seat implements Serializable {
        private static final long serialVersionUID = 1L;
        final UUID playerId;
        /** Process-local diagnostic identity ONLY. Must never grant recovery access to this seat. */
        final UUID sessionUserId;
        final String displayName;
        final DeckCardLists deck;
        final int wins;
        final int prioritySeconds;
        final int bufferSeconds;
        final int matchPrioritySeconds;

        Seat(UUID user, MatchPlayer matchPlayer, Player frozenPlayer) {
            playerId = frozenPlayer.getId();
            sessionUserId = user;
            displayName = frozenPlayer.getName();
            deck = matchPlayer.getDeck().prepareCardsOnlyDeck();
            wins = matchPlayer.getWins();
            prioritySeconds = frozenPlayer.getPriorityTimeLeft();
            bufferSeconds = frozenPlayer.getBufferTimeLeft();
            matchPrioritySeconds = matchPlayer.getPriorityTimeLeft();
        }
    }

    static byte[] bytes(Object object) throws IOException {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        try (ObjectOutputStream out = new ObjectOutputStream(bytes)) {
            out.writeObject(object);
        }
        return bytes.toByteArray();
    }

    /** Trusted local diagnostics only, after envelope compatibility/integrity checks. */
    static Object read(byte[] bytes) throws IOException, ClassNotFoundException {
        try (ObjectInputStream in = new ObjectInputStream(new ByteArrayInputStream(bytes))) {
            return in.readObject();
        }
    }
}
