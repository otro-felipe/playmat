package mage.server.replay;

import com.google.gson.JsonObject;
import com.google.gson.JsonArray;
import mage.game.Table;
import mage.game.TwoPlayerMatch;
import mage.game.match.ChampionshipRules;
import mage.game.match.MatchOptions;
import mage.players.Player;
import mage.view.ChatMessage;
import org.junit.jupiter.api.Test;
import java.lang.reflect.Proxy;
import java.util.Date;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import static org.assertj.core.api.Assertions.assertThat;

class SpectatorTableTest {
    @Test void aTournamentBroadcastUsesMatchWinsBetweenGamesEvenWhileTheBoardIsUnchanged() {
        MatchOptions options = new MatchOptions("Test", "Two Player Duel", false);
        options.championship = new ChampionshipRules(UUID.randomUUID(), "Alice", "Bob", false, 1, 0);
        TwoPlayerMatch match = new TwoPlayerMatch(options);
        Player alice = seat("Alice"), bob = seat("Bob");
        match.addPlayer(alice, null);
        match.addPlayer(bob, null);
        Table table = new Table(UUID.randomUUID(), "Duel", "Test", "Alice", null, List.of(), ignored -> {},
                match, Set.of(), false);
        SpectatorTable state = SpectatorTable.start(table, UUID.randomUUID());
        JsonObject empty = new JsonObject();
        state.frame(empty, empty, empty);
        JsonObject live = SpectatorTable.lookup(table.getId(), table).getAsJsonObject("snapshot");
        assertThat(live.getAsJsonObject("matchWins").get("Alice").getAsInt()).isZero();
        match.getPlayers().get(0).addWin();
        SpectatorTable.end(state);
        JsonObject between = SpectatorTable.lookup(table.getId(), table).getAsJsonObject("snapshot");
        assertThat(between.get("status").getAsString()).isEqualTo("between_games");
        assertThat(between.getAsJsonObject("matchWins").get("Alice").getAsInt()).isOne();
        assertThat(between.getAsJsonObject("matchWins").get("Bob").getAsInt()).isZero();
        assertThat(between.getAsJsonObject("view")).isEqualTo(live.getAsJsonObject("view"));
    }

    private Player seat(String name) {
        return (Player) Proxy.newProxyInstance(Player.class.getClassLoader(), new Class<?>[]{Player.class},
                (proxy, method, args) -> "getName".equals(method.getName()) ? name : null);
    }

    @Test void aRestoredFrameAndItsBranchArePublishedTogetherEvenWhenTheTurnDoesNotChange() {
        SpectatorTable table = new SpectatorTable(UUID.randomUUID(), UUID.randomUUID(), "Fixture");
        JsonObject view = new JsonObject();
        view.addProperty("turn", 8);
        JsonObject empty = new JsonObject();
        table.frame(view, empty, empty, empty, 0);
        long revision = table.snapshot().get("revision").getAsLong();
        table.frame(view, empty, empty, empty, 2);
        for (boolean privateSeats : new boolean[]{false, true}) {
            JsonObject result = table.snapshot(privateSeats);
            assertThat(result.get("rollbackRevision").getAsLong()).isEqualTo(2);
            assertThat(result.get("revision").getAsLong()).isGreaterThan(revision);
            assertThat(result.getAsJsonObject("view").get("turn").getAsInt()).isEqualTo(8);
            assertThat(result.has("seatKnowledge")).isEqualTo(privateSeats);
        }
        table.frame(view, empty, empty, empty, 2);
        assertThat(table.snapshot().get("rollbackRevision").getAsLong()).isEqualTo(2);
    }

    @Test void privateKnowledgeRequiresExplicitAccessAndUsesOnlyTheSeatPerspective() {
        UUID a = UUID.randomUUID(), b = UUID.randomUUID();
        JsonObject visible = new JsonObject(), seat = new JsonObject(), seats = new JsonObject(), review = new JsonObject();
        JsonArray players = new JsonArray();
        for (UUID id : new UUID[]{a, b}) {
            JsonObject player = new JsonObject(), top = new JsonObject();
            player.addProperty("playerId", id.toString());
            top.addProperty("name", id.equals(a) ? "Observed card" : "Other seat only");
            player.add("topCard", top);
            players.add(player);
        }
        visible.add("players", new JsonArray());
        visible.add("revealed", new JsonArray());
        seat.add("players", players);
        seat.add("lookedAt", new JsonArray());
        seat.addProperty("library", "Hidden order");
        seats.add(a.toString(), seat);
        review.add("seatViews", seats);
        JsonObject knowledge = ReplayEvidence.spectatorSeatKnowledge(review, visible);
        SpectatorTable broadcast = new SpectatorTable(UUID.randomUUID(), UUID.randomUUID(), "Synthetic host");
        broadcast.frame(visible, new JsonObject(), new JsonObject(), knowledge, 0);
        assertThat(broadcast.snapshot().has("seatKnowledge")).isFalse();
        JsonObject shown = broadcast.snapshot(true).getAsJsonObject("seatKnowledge").getAsJsonObject(a.toString());
        assertThat(shown.keySet()).containsExactlyInAnyOrder("topCard", "lookedAt", "revealed");
        assertThat(shown.getAsJsonObject("topCard").get("name").getAsString()).isEqualTo("Observed card");
    }

    @Test void aBroadcastContainsHandsBySeatAndOnlyTableTalkAndCommittedLines() {
        UUID table=UUID.randomUUID(), game=UUID.randomUUID(), alice=UUID.randomUUID(), bob=UUID.randomUUID();
        SpectatorTable broadcast=new SpectatorTable(table, game, "Alice");
        JsonObject hands=new JsonObject(), cards=new JsonObject();
        cards.addProperty("card", "Island"); hands.add(alice.toString(), cards);
        hands.add(bob.toString(), new JsonObject());
        JsonObject players=new JsonObject(); players.addProperty(alice.toString(),"Alice"); players.addProperty(bob.toString(),"Bob");
        broadcast.frame(new JsonObject(), hands, players);
        JsonObject publicNote=new JsonObject(); publicNote.addProperty("explanation","Play a land.");
        broadcast.line(alice, "same-command", LineExplanation.read(publicNote), 2, 42);
        JsonObject legacyNote=new JsonObject(); legacyNote.addProperty("reasoning","Keep priority.");
        broadcast.line(bob, "same-command", LineExplanation.read(legacyNote), 2, 43);
        broadcast.chat(new ChatMessage("Alice","&iexcl;S&iacute;! &laquo;hola&raquo; &amp; literal &amp;amp;",new Date(42),null,ChatMessage.MessageColor.BLACK,ChatMessage.MessageType.TALK,null));
        broadcast.chat(new ChatMessage("Bob","Private",new Date(43),null,ChatMessage.MessageColor.BLACK,ChatMessage.MessageType.WHISPER_FROM,null));
        JsonObject snap=broadcast.snapshot();
        assertThat(snap.getAsJsonObject("hands").size()).isEqualTo(2);
        assertThat(snap.getAsJsonArray("lines").size()).isEqualTo(2);
        assertThat(snap.getAsJsonArray("lines").get(0).getAsJsonObject().get("lineId")).isNotEqualTo(snap.getAsJsonArray("lines").get(1).getAsJsonObject().get("lineId"));
        assertThat(snap.getAsJsonArray("lines").get(0).getAsJsonObject().get("audience").getAsString()).isEqualTo("public");
        assertThat(snap.getAsJsonArray("lines").get(1).getAsJsonObject().has("audience")).isFalse();
        assertThat(snap.getAsJsonArray("chat").size()).isEqualTo(1);
        assertThat(snap.getAsJsonArray("chat").get(0).getAsJsonObject().get("message").getAsString())
                .isEqualTo("¡Sí! «hola» & literal &amp;");
        assertThat(snap.toString()).doesNotContain("Private");
    }
}
