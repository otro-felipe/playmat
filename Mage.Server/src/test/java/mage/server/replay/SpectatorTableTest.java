package mage.server.replay;

import com.google.gson.JsonObject;
import mage.view.ChatMessage;
import org.junit.jupiter.api.Test;
import java.util.Date;
import java.util.UUID;
import static org.assertj.core.api.Assertions.assertThat;

class SpectatorTableTest {
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
