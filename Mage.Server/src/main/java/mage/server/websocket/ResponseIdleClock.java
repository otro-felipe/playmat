package mage.server.websocket;

import com.google.gson.JsonObject;

/** Resamples the already-authorized own-seat deadline on send, including cached prompt/state replays. */
final class ResponseIdleClock {
    private ResponseIdleClock() { }

    static void refresh(JsonObject message, long now, boolean noPendingResponse) {
        if (!message.has("data") || !message.get("data").isJsonObject()) return;
        JsonObject data = message.getAsJsonObject("data");
        JsonObject view = data.has("gameView") && data.get("gameView").isJsonObject() ? data.getAsJsonObject("gameView") : data;
        if (!view.has("responseIdle") || !view.get("responseIdle").isJsonObject()) return;
        JsonObject timing = view.getAsJsonObject("responseIdle");
        if (!timing.has("status") || !"running".equals(timing.get("status").getAsString())) return;
        if (noPendingResponse) {
            timing.addProperty("status", "inactive");
            timing.remove("deadlineEpochMs");
            timing.remove("remainingMillis");
            timing.remove("timeoutSeconds");
        } else if (timing.has("deadlineEpochMs") && timing.get("deadlineEpochMs").isJsonPrimitive()) {
            timing.addProperty("remainingMillis", Math.max(0, timing.get("deadlineEpochMs").getAsLong() - now));
        }
        timing.addProperty("sampledAtEpochMs", now);
    }
}
