package mage.server.replay;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParseException;
import com.google.gson.JsonParser;
import com.google.gson.stream.JsonReader;
import com.google.gson.stream.JsonToken;
import mage.server.playtesting.ProductGateway;
import mage.server.websocket.rpc.JsonCodec;
import org.apache.log4j.Logger;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.Reader;
import java.io.Writer;
import java.nio.charset.StandardCharsets;
import java.nio.file.DirectoryStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.TimeUnit;
import java.util.zip.GZIPInputStream;

/**
 * Recorded games on disk: {@code <gameId>.json} (the {@link ReplayInfo}) next to {@code <gameId>.ndjson.gz} (one JSON
 * event per line: {@code {"t":ms,"view":GameView,"hands":{name:CardsView}}} or {@code {"t":ms,"log":ChatMessage}}).
 * A recording in progress is {@code <gameId>.ndjson.gz.part} until the game ends.
 */
public final class ReplayStore {

    private static final Logger logger = Logger.getLogger(ReplayStore.class);

    static final String EVENTS_SUFFIX = ".ndjson.gz";
    static final String PART_SUFFIX = EVENTS_SUFFIX + ".part";
    static final String INFO_SUFFIX = ".json";

    /** at most this many events per page: a page of board snapshots stays within a few megabytes */
    public static final int MAX_PAGE = 200;

    private static volatile ReplayStore instance;

    private final ReplaySettings settings;
    /** the last replays opened, so paging through one doesn't reread the file for every page */
    private final Map<String, List<String>> openReplays = Collections.synchronizedMap(new LinkedHashMap<String, List<String>>(4, 0.75f, true) {
        @Override
        protected boolean removeEldestEntry(Map.Entry<String, List<String>> eldest) {
            return size() > 2;
        }
    });

    ReplayStore(ReplaySettings settings) {
        this.settings = settings;
    }

    public static ReplayStore get() {
        if (instance == null) {
            synchronized (ReplayStore.class) {
                if (instance == null) {
                    instance = new ReplayStore(ReplaySettings.fromSystemProperties());
                    instance.prune();
                }
            }
        }
        return instance;
    }

    public ReplaySettings settings() {
        return settings;
    }

    /** Inspect only metadata identifiers. Missing or unreadable metadata for an event file cannot prove absence. */
    public static boolean hasChampionshipEvidence(Path directory, UUID tableId, UUID pairingId) throws IOException {
        if (Files.notExists(directory)) return false;
        try (DirectoryStream<Path> files = Files.newDirectoryStream(directory)) {
            for (Path file : files) {
                String name = file.getFileName().toString();
                if (name.endsWith(INFO_SUFFIX)) {
                    try (JsonReader json = new JsonReader(Files.newBufferedReader(file, StandardCharsets.UTF_8))) {
                        if (containsIdentifiers(json, tableId.toString(), pairingId.toString(), true)) return true;
                    }
                } else if (name.endsWith(EVENTS_SUFFIX) || name.endsWith(PART_SUFFIX)) {
                    String game = name.substring(0, name.length() - (name.endsWith(PART_SUFFIX) ? PART_SUFFIX.length() : EVENTS_SUFFIX.length()));
                    if (!Files.isRegularFile(directory.resolve(game + INFO_SUFFIX))
                            && !Files.isRegularFile(directory.resolve(game + ".active.json"))
                            && !Files.isRegularFile(directory.resolve(game + ".interrupted.json"))) return true;
                }
            }
        }
        return false;
    }

    private static boolean containsIdentifiers(JsonReader json, String tableId, String pairingId, boolean topLevel) throws IOException {
        json.beginObject();
        while (json.hasNext()) {
            String key = json.nextName();
            if (("tableId".equals(key) || "pairingId".equals(key)) && json.peek() == JsonToken.STRING) {
                if (("tableId".equals(key) ? tableId : pairingId).equals(json.nextString())) return true;
            } else if (topLevel && "tournamentScore".equals(key) && json.peek() == JsonToken.BEGIN_OBJECT) {
                if (containsIdentifiers(json, tableId, pairingId, false)) return true;
            } else {
                json.skipValue();
            }
        }
        json.endObject();
        return false;
    }

    Path eventsFile(String gameId) {
        return settings.dir.resolve(gameId + EVENTS_SUFFIX);
    }

    Path partFile(String gameId) {
        return settings.dir.resolve(gameId + PART_SUFFIX);
    }

    Path infoFile(String gameId) {
        return settings.dir.resolve(gameId + INFO_SUFFIX);
    }

    /** a recording is done: its events file takes its final name and its info is written */
    synchronized void complete(ReplayInfo info) {
        try {
            Path part = partFile(info.gameId);
            if (!Files.exists(part)) {
                return;
            }
            Files.move(part, eventsFile(info.gameId), StandardCopyOption.REPLACE_EXISTING);
            writeAtomically(infoFile(info.gameId), JsonCodec.GSON.toJsonTree(info));
            if (ProductGateway.enabled()) {
                Files.deleteIfExists(settings.dir.resolve(info.gameId + ".active.json"));
            }
        } catch (IOException e) {
            logger.error("Can't finish the replay of game " + info.gameId, e);
        }
        prune();
    }

    void markActive(ReplayInfo info) {
        try {
            writeAtomically(settings.dir.resolve(info.gameId + ".active.json"), JsonCodec.GSON.toJsonTree(info));
        } catch (IOException exception) {
            logger.error("Can't stage replay metadata for " + info.gameId, exception);
        }
    }

    void markMatchEnded(UUID matchId, JsonObject result) {
        try {
            Files.createDirectories(settings.dir);
            writeAtomically(settings.dir.resolve(matchId + ".match.json"), result);
        } catch (IOException exception) {
            logger.error("Can't stage match metadata for " + matchId, exception);
        }
    }

    private static void writeAtomically(Path path, JsonElement payload) throws IOException {
        Path temporary = Files.createTempFile(path.getParent(), ".replay-", ".tmp");
        try {
            try (Writer writer = Files.newBufferedWriter(temporary, StandardCharsets.UTF_8)) {
                JsonCodec.GSON.toJson(payload, writer);
            }
            Files.move(temporary, path, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
        } finally {
            Files.deleteIfExists(temporary);
        }
    }

    /** finished replays, newest first */
    public List<ReplayInfo> list() {
        List<ReplayInfo> infos = new ArrayList<>();
        if (!Files.isDirectory(settings.dir)) {
            return infos;
        }
        try (DirectoryStream<Path> files = Files.newDirectoryStream(settings.dir, "*" + INFO_SUFFIX)) {
            for (Path file : files) {
                ReplayInfo info = readInfo(file);
                if (info != null && info.batchOwner == null && Files.exists(eventsFile(info.gameId))) {
                    infos.add(nativeInfo(info));
                }
            }
        } catch (IOException e) {
            logger.error("Can't list replays in " + settings.dir, e);
        }
        infos.sort(Comparator.comparingLong((ReplayInfo info) -> info.startedAt).reversed());
        return infos;
    }

    public ReplayInfo info(UUID gameId) {
        Path file = infoFile(gameId.toString());
        return Files.exists(file) ? readInfo(file) : null;
    }

    /**
     * One page of a replay's events. Hands are private: a page keeps only the viewer's own hand (when they played).
     *
     * @return {info, total, start, events} or null when there is no such replay
     */
    public JsonObject page(UUID gameId, int start, int count, String viewerName) throws IOException {
        ReplayInfo info = info(gameId);
        if (info == null) {
            return null;
        }
        List<String> lines = lines(gameId.toString());
        int from = Math.max(0, Math.min(start, lines.size()));
        int to = Math.min(lines.size(), from + Math.max(1, Math.min(count, MAX_PAGE)));
        JsonArray events = new JsonArray();
        for (String line : lines.subList(from, to)) {
            events.add(nativeEvent(JsonParser.parseString(line).getAsJsonObject(), viewerName));
        }
        JsonObject page = new JsonObject();
        info.events = lines.size();
        page.add("info", JsonCodec.GSON.toJsonTree(nativeInfo(info)));
        page.addProperty("total", lines.size());
        page.addProperty("start", from);
        page.add("events", events);
        return page;
    }

    private static ReplayInfo nativeInfo(ReplayInfo info) {
        info.reviewVersion = null;
        info.reviewIncomplete = null;
        for (ReplayInfo.ReplayPlayer player : info.players) {
            player.deck = null;
            player.playerId = null;
        }
        return info;
    }

    private static JsonObject nativeEvent(JsonObject archived, String viewerName) {
        JsonObject event = new JsonObject();
        event.add("t", archived.get("t"));
        if (archived.has("log")) {
            event.add("log", archived.get("log"));
        } else if (archived.has("view")) {
            event.add("view", archived.get("view"));
            JsonElement hands = archived.get("hands");
            if (hands != null && hands.isJsonObject() && viewerName != null && hands.getAsJsonObject().has(viewerName)) {
                event.add("myHand", hands.getAsJsonObject().get(viewerName));
            }
        } else {
            event.addProperty("kind", "rollback");
            event.add("turn", archived.get("turn"));
        }
        return event;
    }

    private static boolean isNativeEvent(String line) {
        try {
            JsonElement parsed = JsonParser.parseString(line);
            if (!parsed.isJsonObject()) {
                return false;
            }
            JsonObject archived = parsed.getAsJsonObject();
            if (archived.has("kind")) {
                return archived.get("kind").isJsonPrimitive()
                        && "rollback".equals(archived.get("kind").getAsString()) && archived.has("turn");
            }
            return (archived.has("view") && archived.get("view").isJsonObject())
                    || (archived.has("log") && archived.get("log").isJsonObject());
        } catch (JsonParseException exception) {
            return false;
        }
    }

    private List<String> lines(String gameId) throws IOException {
        List<String> cached = openReplays.get(gameId);
        if (cached != null) {
            return cached;
        }
        List<String> lines = new ArrayList<>();
        try (Reader reader = new InputStreamReader(new GZIPInputStream(Files.newInputStream(eventsFile(gameId))), StandardCharsets.UTF_8);
             BufferedReader buffered = new BufferedReader(reader)) {
            String line;
            while ((line = buffered.readLine()) != null) {
                if (!line.isEmpty() && isNativeEvent(line)) {
                    lines.add(line);
                }
            }
        }
        List<String> result = Collections.unmodifiableList(lines);
        openReplays.put(gameId, result);
        return result;
    }

    private static ReplayInfo readInfo(Path file) {
        try (Reader reader = Files.newBufferedReader(file, StandardCharsets.UTF_8)) {
            return JsonCodec.GSON.fromJson(reader, ReplayInfo.class);
        } catch (Exception e) {
            logger.warn("Unreadable replay info " + file + ": " + e);
            return null;
        }
    }

    /** drops replays past the retention or the count limit, and recordings a crash left unfinished */
    public synchronized void prune() {
        if (ProductGateway.enabled() || !Files.isDirectory(settings.dir)) {
            return;
        }
        long now = System.currentTimeMillis();
        long oldest = now - TimeUnit.DAYS.toMillis(settings.retentionDays);
        List<ReplayInfo> kept = new ArrayList<>();
        for (ReplayInfo info : list()) {
            if (info.startedAt < oldest || kept.size() >= settings.maxCount) {
                delete(info.gameId);
            } else {
                kept.add(info);
            }
        }
        try (DirectoryStream<Path> parts = Files.newDirectoryStream(settings.dir, "*" + PART_SUFFIX)) {
            for (Path part : parts) {
                if (Files.getLastModifiedTime(part).toMillis() < now - TimeUnit.DAYS.toMillis(1)) {
                    Files.deleteIfExists(part);
                }
            }
        } catch (IOException e) {
            logger.warn("Can't clean unfinished replays in " + settings.dir + ": " + e);
        }
    }

    /** a recorded game goes (a batch game that wasn't one of the closest) */
    public void remove(String gameId) {
        delete(gameId);
    }

    private void delete(String gameId) {
        openReplays.remove(gameId);
        try {
            Files.deleteIfExists(eventsFile(gameId));
            Files.deleteIfExists(infoFile(gameId));
        } catch (IOException e) {
            logger.warn("Can't delete replay " + gameId + ": " + e);
        }
    }
}
