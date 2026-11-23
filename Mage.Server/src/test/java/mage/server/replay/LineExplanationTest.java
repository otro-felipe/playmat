package mage.server.replay;

import com.google.gson.JsonObject;
import org.junit.jupiter.api.Test;
import java.util.Collections;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatIllegalArgumentException;

class LineExplanationTest {
    @Test void onlyExplicitlyPublishedTextSurvivesAsPublicInArchiveAndBroadcast() {
        JsonObject incoming = new JsonObject(), stored = new JsonObject();
        String full = String.join("", Collections.nCopies(4000, "a"));
        incoming.addProperty("explanation", " " + full + " ");
        LineExplanation.read(incoming).writeTo(stored);
        assertThat(stored.get("explanation").getAsString()).hasSize(4000);
        assertThat(stored.get("audience").getAsString()).isEqualTo("public");
        incoming.addProperty("reasoning", "legacy");
        assertThatIllegalArgumentException().isThrownBy(() -> LineExplanation.read(incoming));
        incoming.remove("explanation");
        incoming.addProperty("audience", "public");
        JsonObject legacy = new JsonObject();
        LineExplanation.read(incoming).writeTo(legacy);
        assertThat(legacy.keySet()).containsExactly("reasoning");
        incoming.remove("reasoning");
        for (String invalid : new String[]{" ", full + "!"}) {
            incoming.addProperty("explanation", invalid);
            assertThatIllegalArgumentException().isThrownBy(() -> LineExplanation.read(incoming));
        }
    }
}
