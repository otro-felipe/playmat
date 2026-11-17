package mage.server.playtesting;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import mage.server.websocket.rpc.RpcException;

import java.io.IOException;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.UUID;

/** The private product process co-located with the Java bridge. Only the verified ingress can reach the bridge. */
public final class ProductGateway {
    private static final boolean ENABLED = "true".equalsIgnoreCase(System.getenv("PLAYMAT_PRIVATE_BETA"));
    private static final HttpClient HTTP = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(1)).build();

    private ProductGateway() {
    }

    public static boolean enabled() {
        return ENABLED;
    }

    private static URI endpoint(String path) {
        String port = System.getenv().getOrDefault("PRODUCT_PORT", "8790");
        return URI.create("http://127.0.0.1:" + Integer.parseInt(port) + path);
    }

    public static boolean canJoin(UUID tableId, String hostEngineName, String guestEngineName) {
        if (hostEngineName == null || guestEngineName == null) {
            return false;
        }
        String host = URLEncoder.encode(hostEngineName, StandardCharsets.UTF_8);
        String guest = URLEncoder.encode(guestEngineName, StandardCharsets.UTF_8);
        HttpRequest request = HttpRequest.newBuilder(endpoint("/internal/invites/" + tableId + "?host=" + host + "&guest=" + guest))
                .timeout(Duration.ofSeconds(2)).GET().build();
        try {
            return HTTP.send(request, HttpResponse.BodyHandlers.discarding()).statusCode() == 200;
        } catch (InterruptedException exception) {
            Thread.currentThread().interrupt();
            return false;
        } catch (IOException exception) {
            return false;
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
        HttpRequest request = HttpRequest.newBuilder(endpoint("/internal/legacy"))
                .timeout(Duration.ofSeconds(10))
                .header("Content-Type", "application/json")
                .header("X-Playmat-Engine-User", engineName)
                .POST(HttpRequest.BodyPublishers.ofString(body.toString()))
                .build();
        try {
            HttpResponse<String> response = HTTP.send(request, HttpResponse.BodyHandlers.ofString());
            if (response.statusCode() == 401 || response.statusCode() == 403) {
                throw RpcException.notAuthorized("Replay access is not available to this seat");
            }
            if (response.statusCode() != 200) {
                throw new RpcException(RpcException.SERVER_ERROR, "The replay service is unavailable");
            }
            return JsonParser.parseString(response.body());
        } catch (InterruptedException exception) {
            Thread.currentThread().interrupt();
            throw new RpcException(RpcException.SERVER_ERROR, "The replay request was interrupted");
        } catch (IOException | com.google.gson.JsonParseException exception) {
            throw new RpcException(RpcException.SERVER_ERROR, "The replay service is unavailable");
        }
    }
}
