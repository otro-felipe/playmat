package mage.server.websocket;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.jupiter.api.Test;
import java.util.UUID;
import mage.interfaces.callback.ClientCallbackMethod;
import static org.assertj.core.api.Assertions.*;

class ResponseIdleClockTest {
    private JsonObject prompt() {
        return JsonParser.parseString("{\"data\":{\"gameView\":{\"responseIdle\":{\"status\":\"running\",\"deadlineEpochMs\":10000,\"sampledAtEpochMs\":1000,\"remainingMillis\":9000,\"timeoutSeconds\":60}}}}").getAsJsonObject();
    }
    @Test void resendingACachedPromptResamplesButNeverExtendsItsDeadline() {
        JsonObject message = prompt();
        ResponseIdleClock.refresh(message, 4000, false);
        JsonObject timing = message.getAsJsonObject("data").getAsJsonObject("gameView").getAsJsonObject("responseIdle");
        assertThat(timing.get("deadlineEpochMs").getAsLong()).isEqualTo(10000);
        assertThat(timing.get("remainingMillis").getAsLong()).isEqualTo(6000);
        assertThat(timing.get("sampledAtEpochMs").getAsLong()).isEqualTo(4000);
        ResponseIdleClock.refresh(message, 10001, false);
        assertThat(timing.get("remainingMillis").getAsLong()).isZero();
    }
    @Test void replayingAnAnsweredStateCannotInventAPendingTimer() {
        JsonObject message = prompt();
        ResponseIdleClock.refresh(message, 4000, true);
        JsonObject timing = message.getAsJsonObject("data").getAsJsonObject("gameView").getAsJsonObject("responseIdle");
        assertThat(timing.get("status").getAsString()).isEqualTo("inactive");
        assertThat(timing.has("deadlineEpochMs")).isFalse();
        assertThat(timing.has("remainingMillis")).isFalse();
    }
    @Test void resyncKeepsItsRefreshedPatchBaselineConsistentAndClearsAnAnsweredTimer() {
        GameStates states = new GameStates();
        states.setEnabled(true);
        UUID game = UUID.randomUUID();
        states.encode(ClientCallbackMethod.GAME_SELECT, game, prompt());
        JsonObject resynced = JsonParser.parseString(states.resync(game, false)).getAsJsonObject();
        JsonObject baseline = resynced.getAsJsonObject("data");
        assertThat(baseline.getAsJsonObject("responseIdle").get("status").getAsString()).isEqualTo("inactive");
        JsonObject next = baseline.deepCopy();
        next.addProperty("turn", 2);
        JsonObject message = new JsonObject();
        message.add("data", next);
        GameStates.Encoded encoded = states.encode(ClientCallbackMethod.GAME_UPDATE, game, message);
        JsonObject wire = JsonParser.parseString(encoded.json).getAsJsonObject();
        com.google.gson.JsonElement decoded = wire.getAsJsonObject("state").has("patch")
                ? StateDiff.apply(baseline, wire.getAsJsonObject("state").get("patch")) : wire.get("data");
        assertThat(decoded).isEqualTo(next);
    }

}
