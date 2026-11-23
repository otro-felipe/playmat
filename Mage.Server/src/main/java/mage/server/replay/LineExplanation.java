package mage.server.replay;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;

/** An authored comment is public only when the seat supplied the publication field. */
public final class LineExplanation {
    private final String text;
    private final boolean published;

    private LineExplanation(String text, boolean published) {
        this.text = text;
        this.published = published;
    }

    public static LineExplanation read(JsonObject line) {
        boolean published = line.has("explanation");
        if (published && line.has("reasoning")) throw new IllegalArgumentException("Supply either explanation or legacy reasoning");
        String field = published ? "explanation" : "reasoning";
        JsonElement value = line.get(field);
        if (value == null || !value.isJsonPrimitive() || !value.getAsJsonPrimitive().isString()) {
            throw new IllegalArgumentException("Invalid replay line " + field);
        }
        String text = value.getAsString().trim();
        int length = published ? text.codePointCount(0, text.length()) : text.length();
        if (text.isEmpty() || length > (published ? 4000 : 600)) throw new IllegalArgumentException("Invalid replay line " + field);
        return new LineExplanation(text, published);
    }

    void writeTo(JsonObject row) {
        row.addProperty(published ? "explanation" : "reasoning", text);
        if (published) row.addProperty("audience", "public");
    }
}
