package mage.server.replay;

import com.google.gson.JsonObject;
import org.junit.jupiter.api.Test;
import java.util.Collections;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatIllegalArgumentException;

class LineExplanationTest {
    @Test void onlyExplicitlyPublishedTextSurvivesAsPublicInArchiveAndBroadcast() {
        JsonObject incoming = new JsonObject(), stored = new JsonObject();
        String full = String.join("", Collections.nCopies(4000, "🃏"));
        incoming.addProperty("explanation", " " + full + " ");
        LineExplanation.read(incoming).writeTo(stored);
        assertThat(stored.get("explanation").getAsString()).isEqualTo(full);
        assertThat(stored.get("audience").getAsString()).isEqualTo("public");
        incoming.addProperty("reasoning", "legacy");
        assertThatIllegalArgumentException().isThrownBy(() -> LineExplanation.read(incoming));
        incoming.remove("explanation");
        incoming.addProperty("audience", "public");
        JsonObject legacy = new JsonObject();
        LineExplanation.read(incoming).writeTo(legacy);
        assertThat(legacy.keySet()).containsExactly("reasoning");
        String legacyLimit = String.join("", Collections.nCopies(300, "🃏"));
        incoming.addProperty("reasoning", legacyLimit);
        LineExplanation.read(incoming).writeTo(legacy);
        assertThat(legacy.get("reasoning").getAsString()).isEqualTo(legacyLimit);
        incoming.addProperty("reasoning", legacyLimit + "🃏");
        assertThatIllegalArgumentException().isThrownBy(() -> LineExplanation.read(incoming));
        incoming.remove("reasoning");
        for (String invalid : new String[]{" ", full + "🃏"}) {
            incoming.addProperty("explanation", invalid);
            assertThatIllegalArgumentException().isThrownBy(() -> LineExplanation.read(incoming));
        }
    }
}
