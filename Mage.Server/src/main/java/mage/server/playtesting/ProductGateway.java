package mage.server.playtesting;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParseException;
import com.google.gson.JsonParser;
import mage.server.websocket.rpc.RpcException;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.HashSet;
import java.util.Set;
import java.util.UUID;

/** The private product process co-located with the Java bridge. */
public final class ProductGateway {
    private static final boolean ENABLED = "true".equalsIgnoreCase(System.getenv("PLAYMAT_PRIVATE_BETA"));
    private static final int MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

    private ProductGateway() {
    }

    public static boolean enabled() {
        return ENABLED;
    }

    public static boolean recoveryPrincipalValid(mage.server.recovery.RecoveryPrincipal principal) {
        if (!enabled() || principal == null) return false;
        JsonObject body = new JsonObject();
        body.addProperty("accountId", principal.accountId.toString());
        body.addProperty("seatId", principal.seatId);
        if (principal.connectionId != null) body.addProperty("connectionId", principal.connectionId.toString());
        try { return request("/internal/recovery/validate", 2000, "", body, false).status == 200; }
        catch (IOException | RuntimeException e) { return false; }
    }

    private static String parameter(String value) throws IOException {
        return URLEncoder.encode(value, StandardCharsets.UTF_8.name());
    }

    private static class Response {
        final int status;
        final String body;

        Response(int status, String body) {
            this.status = status;
            this.body = body;
        }
    }

    private static Response request(String path, int readTimeout, String engineName, JsonObject payload, boolean readBody)
            throws IOException {
        int port = Integer.parseInt(System.getenv().getOrDefault("PRODUCT_PORT", "8790"));
        HttpURLConnection connection = (HttpURLConnection) new URL("http", "127.0.0.1", port, path).openConnection();
        connection.setInstanceFollowRedirects(false);
        connection.setConnectTimeout(1000);
        connection.setReadTimeout(readTimeout);
        try {
            if (payload != null) {
                byte[] bytes = payload.toString().getBytes(StandardCharsets.UTF_8);
                connection.setRequestMethod("POST");
                connection.setDoOutput(true);
                connection.setFixedLengthStreamingMode(bytes.length);
                connection.setRequestProperty("Content-Type", "application/json");
                connection.setRequestProperty("X-Playmat-Engine-User", engineName);
                try (OutputStream output = connection.getOutputStream()) {
                    output.write(bytes);
                }
            }
            int status = connection.getResponseCode();
            if (status != 200 || !readBody) {
                return new Response(status, "");
            }
            try (InputStream input = connection.getInputStream();
                 ByteArrayOutputStream output = new ByteArrayOutputStream()) {
                byte[] buffer = new byte[8192];
                for (int length; (length = input.read(buffer)) != -1; ) {
                    if (output.size() + length > MAX_RESPONSE_BYTES) {
                        throw new IOException("The product response is too large");
                    }
                    output.write(buffer, 0, length);
                }
                return new Response(status, output.toString(StandardCharsets.UTF_8.name()));
            }
        } finally {
            connection.disconnect();
        }
    }

    public static boolean canJoin(UUID tableId, String hostEngineName, String guestEngineName) {
        if (hostEngineName == null || guestEngineName == null) {
            return false;
        }
        try {
            String path = "/internal/invites/" + tableId + "?host=" + parameter(hostEngineName)
                    + "&guest=" + parameter(guestEngineName);
            return request(path, 2000, null, null, false).status == 200;
        } catch (IOException exception) {
            return false;
        }
    }

    public static Set<UUID> visibleInvitations(String engineName) {
        if (engineName == null || engineName.trim().isEmpty()) {
            return Collections.emptySet();
        }
        try {
            Response response = request("/internal/invites?guest=" + parameter(engineName), 2000, null, null, true);
            if (response.status != 200) {
                return Collections.emptySet();
            }
            Set<UUID> result = new HashSet<>();
            JsonParser.parseString(response.body).getAsJsonArray().forEach(id -> result.add(UUID.fromString(id.getAsString())));
            return result;
        } catch (IOException | IllegalArgumentException | IllegalStateException | JsonParseException exception) {
            return Collections.emptySet();
        }
    }

    public static JsonElement replay(String engineName, String method, UUID gameId, int start, int count) throws RpcException {
        JsonObject body = new JsonObject();
        body.addProperty("method", method);
        if (gameId != null) {
            body.addProperty("gameId", gameId.toString());
            body.addProperty("start", start);
            body.addProperty("count", count);
        }
        try {
            Response response = request("/internal/legacy", 10000, engineName, body, true);
            if (response.status == 401 || response.status == 403) {
                throw RpcException.notAuthorized("Replay access is not available to this seat");
            }
            if (response.status != 200) {
                throw new RpcException(RpcException.SERVER_ERROR, "The replay service is unavailable");
            }
            return JsonParser.parseString(response.body);
        } catch (IOException | JsonParseException exception) {
            throw new RpcException(RpcException.SERVER_ERROR, "The replay service is unavailable");
        }
    }
}
