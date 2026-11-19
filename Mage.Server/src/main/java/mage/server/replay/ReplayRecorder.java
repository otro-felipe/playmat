package mage.server.replay;

import com.google.gson.JsonObject;
import mage.game.Game;
import mage.game.Table;
import mage.game.events.GameEvent;
import mage.game.match.Match;
import mage.game.match.MatchPlayer;
import mage.game.mulligan.LondonMulligan;
import mage.game.trace.ReplayDecision;
import mage.game.trace.ReplayPrompt;
import mage.players.Player;
import mage.server.game.GameChangeKey;
import mage.server.playtesting.ProductGateway;
import mage.server.websocket.rpc.JsonCodec;
import mage.view.CardsView;
import mage.view.ChatMessage;
import mage.view.GameView;
import org.apache.log4j.Logger;

import java.io.BufferedWriter;
import java.io.IOException;
import java.io.OutputStreamWriter;
import java.io.Writer;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentMap;
import java.util.function.Consumer;
import java.util.zip.GZIPOutputStream;

/**
 * Records one game for replay, as a spectator sees it: a board snapshot (the watcher's game view) on every update and
 * every line of the game log, plus each human player's hand so they can review their own decisions later. Events
 * stream to disk as the game goes; the replay is listed once the game ends.
 */
public final class ReplayRecorder {

    private static final Logger logger = Logger.getLogger(ReplayRecorder.class);

    /** recorders by game chat, so log lines reach the recording of their game */
    private static final ConcurrentMap<UUID, ReplayRecorder> BY_CHAT = new ConcurrentHashMap<>();
    private static final ConcurrentMap<UUID, ReplayRecorder> BY_GAME = new ConcurrentHashMap<>();

    private final ReplayStore store;
    private final Game game;
    private final UUID chatId;
    private final ReplayInfo info;
    /** the recorder watches like a spectator nobody else can be */
    private final UUID watcherId = UUID.randomUUID();
    private Writer out;
    private String lastFrame;
    private int lastFrameCursor = -1;
    private long replayBranch;
    private ReplayDecision.Subscription decisionSubscription;
    /** what the game looked like at the last snapshot, cheaply (see {@link GameChangeKey}) */
    private String lastKey;
    private boolean finished;
    /** the file couldn't be written */
    private boolean broken;

    private ReplayRecorder(ReplayStore store, Game game, UUID chatId, ReplayInfo info) {
        this.store = store;
        this.game = game;
        this.chatId = chatId;
        this.info = info;
    }

    /**
     * Starts recording a game, or does nothing (null) when replays are off, the game is a simulation or only AI
     * players play it. Call from the game thread or before the game thread starts.
     */
    public static ReplayRecorder start(Game game, Table table, UUID chatId) {
        try {
            ReplayStore store = ReplayStore.get();
            if (!store.settings().enabled || game == null || game.isSimulation()
                    || game.getPlayers().values().stream().noneMatch(Player::isHuman)) {
                return null;
            }
            ReplayInfo info = new ReplayInfo();
            info.gameId = game.getId().toString();
            info.startedAt = System.currentTimeMillis();
            info.gameType = game.getGameType() == null ? null : game.getGameType().getName();
            if (table != null) {
                info.tableId = table.getId().toString();
                info.tableName = table.getName();
                info.deckType = table.getDeckType();
            }
            fillPlayers(info, game, table);
            info.reviewVersion = ProductGateway.reviewCaptureVersion(info.matchId, info.tableId, game.getPlayers().values());

            Files.createDirectories(store.settings().dir);
            ReplayRecorder recorder = new ReplayRecorder(store, game, chatId, info);
            Path part = store.partFile(info.gameId);
            if (info.reviewVersion != null && Files.getFileStore(store.settings().dir).supportsFileAttributeView("posix")) {
                if (!Files.exists(part)) {
                    Files.createFile(part, PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rw-------")));
                } else {
                    Files.setPosixFilePermissions(part, PosixFilePermissions.fromString("rw-------"));
                }
            }
            recorder.out = new BufferedWriter(new OutputStreamWriter(
                    new GZIPOutputStream(Files.newOutputStream(part)), StandardCharsets.UTF_8));
            if (chatId != null) {
                BY_CHAT.put(chatId, recorder);
            }
            if (ProductGateway.enabled()) {
                store.markActive(info);
                BY_GAME.put(game.getId(), recorder);
                if (info.reviewVersion != null) {
                    recorder.decisionSubscription = ReplayDecision.observe(game, recorder::recordDecision, recorder::offerPrompt);
                }
            }
            recorder.frame(true);
            return recorder;
        } catch (Throwable e) {
            logger.error("Can't record game " + (game == null ? null : game.getId()) + " for replay", e);
            return null;
        }
    }

    private static void fillPlayers(ReplayInfo info, Game game, Table table) {
        Match match = table == null ? null : table.getMatch();
        boolean privateProduct = ProductGateway.enabled() && match != null;
        if (privateProduct) {
            info.matchId = match.getId().toString();
            info.winsNeeded = match.getWinsNeeded();
            info.gameNumber = Math.max(1, match.getNumGames());
        }
        for (Player player : game.getPlayers().values()) {
            ReplayInfo.ReplayPlayer seat = new ReplayInfo.ReplayPlayer(player.getName(), player.isHuman());
            if (privateProduct) {
                seat.playerId = player.getId().toString();
                MatchPlayer matchPlayer = match.getPlayer(player.getId());
                if (matchPlayer != null && matchPlayer.getDeck() != null) {
                    seat.deck = matchPlayer.getDeck().prepareCardsOnlyDeck();
                }
            }
            info.players.add(seat);
        }
    }

    /** Called from the committed engine rollback event. Requests and votes do not produce markers. */
    public static void onRollbackCommitted(Game game) {
        ReplayRecorder recorder = BY_GAME.get(game.getId());
        if (recorder != null) {
            recorder.rollback(game.getTurnNum());
        }
    }

    /** The rules watcher sends accepted actions and actual draws directly to the protected spool. */
    public static void onRulesEvent(Game game, GameEvent event) {
        ReplayRecorder recorder = BY_GAME.get(game.getId());
        if (recorder != null && recorder.info.reviewVersion != null) {
            recorder.recordRulesEvent(event);
        }
    }

    private synchronized Consumer<ReplayPrompt.Answer> offerPrompt(ReplayPrompt prompt) {
        // An announcement can still be canceled. Keep its exact offered options but do not publish
        // a new replay board frame revealing a tentative spell to another perspective.
        int frameCursor = prompt.parentActionId == null ? frame(true) : lastFrameCursor;
        if (frameCursor < 0 || !canWrite()) {
            return ReplayPrompt.NO_CAPTURE;
        }
        long branch = replayBranch;
        ReplayEvidence.PreparedPrompt prepared = ReplayEvidence.prompt(game, prompt, frameCursor, elapsed());
        return answer -> recordPrompt(branch, prepared, answer);
    }

    private synchronized void recordPrompt(long branch, ReplayEvidence.PreparedPrompt prepared, ReplayPrompt.Answer answer) {
        if (branch != replayBranch || !canWrite()) {
            return;
        }
        try {
            ReplayEvidence.applyPromptAnswer(game, prepared, answer);
            prepared.row.addProperty("decisionId", "decision-" + info.events);
            write(prepared.row.toString());
        } catch (RuntimeException error) {
            info.reviewIncomplete = true;
            logger.warn("A protected replay prompt could not be captured for game " + game.getId());
        }
    }

    private synchronized void recordDecision(ReplayDecision committed) {
        if (!canWrite()) {
            return;
        }
        try {
            JsonObject row = ReplayEvidence.decision(game, committed, elapsed());
            if (row == null) {
                return;
            }
            int frameCursor = frame(true);
            if (frameCursor >= 0 && canWrite()) {
                row.addProperty("preActionCursor", frameCursor);
                write(row.toString());
            }
        } catch (RuntimeException error) {
            info.reviewIncomplete = true;
            logger.warn("A protected replay decision could not be captured for game " + info.gameId);
        }
    }

    private synchronized void recordRulesEvent(GameEvent event) {
        if (!canWrite()) {
            return;
        }
        try {
            JsonObject row = ReplayEvidence.rulesEvent(game, event, elapsed());
            if (row != null) {
                if (event.getType() == GameEvent.EventType.DREW_CARD && !row.has("card")) {
                    info.reviewIncomplete = true;
                }
                write(row.toString());
            }
        } catch (RuntimeException exception) {
            info.reviewIncomplete = true;
            logger.warn("A protected replay event could not be captured for game " + info.gameId);
        }
    }

    private synchronized void rollback(int turn) {
        if (!canWrite()) {
            return;
        }
        JsonObject event = new JsonObject();
        event.addProperty("t", elapsed());
        event.addProperty("kind", "rollback");
        event.addProperty("turn", turn);
        write(event.toString());
        replayBranch++;
        lastKey = null;
        lastFrame = null;
        lastFrameCursor = -1;
    }

    public static void onMatchEnded(Table table) {
        if (!ProductGateway.enabled() || table.getMatch() == null) {
            return;
        }
        Match match = table.getMatch();
        JsonObject result = new JsonObject();
        result.addProperty("matchId", match.getId().toString());
        result.addProperty("endedAt", System.currentTimeMillis());
        match.getPlayers().stream().filter(MatchPlayer::isMatchWinner).findFirst()
                .ifPresent(winner -> result.addProperty("winner", winner.getName()));
        ReplayStore.get().markMatchEnded(match.getId(), result);
    }

    /**
     * Starts recording an AI-against-AI game of a player's batch (the matchup lab keeps the closest few): frames come
     * from the game's update events and log lines from its info events, since no game controller runs it.
     */
    public static ReplayRecorder startBatch(Game game, String name, String owner) {
        try {
            ReplayStore store = ReplayStore.get();
            if (!store.settings().enabled || game == null) {
                return null;
            }
            ReplayInfo info = new ReplayInfo();
            info.gameId = game.getId().toString();
            info.startedAt = System.currentTimeMillis();
            info.gameType = game.getGameType() == null ? null : game.getGameType().getName();
            info.tableName = name;
            info.batchOwner = owner;
            for (Player player : game.getPlayers().values()) {
                info.players.add(new ReplayInfo.ReplayPlayer(player.getName(), false));
            }
            Files.createDirectories(store.settings().dir);
            ReplayRecorder recorder = new ReplayRecorder(store, game, null, info);
            recorder.out = new BufferedWriter(new OutputStreamWriter(
                    new GZIPOutputStream(Files.newOutputStream(store.partFile(info.gameId))), StandardCharsets.UTF_8));
            game.addTableEventListener((mage.game.events.Listener<mage.game.events.TableEvent>) event -> {
                switch (event.getEventType()) {
                    case UPDATE:
                        recorder.frame();
                        break;
                    case INFO:
                    case STATUS:
                        recorder.log(new ChatMessage("", event.getMessage(), new java.util.Date(), game,
                                mage.view.ChatMessage.MessageColor.BLACK, mage.view.ChatMessage.MessageType.GAME, null));
                        break;
                    default:
                        break;
                }
            });
            recorder.frame(true);
            return recorder;
        } catch (Throwable e) {
            logger.error("Can't record batch game " + (game == null ? null : game.getId()), e);
            return null;
        }
    }

    /**
     * A game the Rust host played and recorded itself, in this store's folder ({@code <gameId>.ndjson.gz.part}, as
     * {@link #start} would have): it's listed as a finished replay. Nothing when replays are off or nothing was
     * recorded.
     */
    public static void hosted(Game game, Table table, long startedAt, String result, int turns, int events) {
        try {
            ReplayStore store = ReplayStore.get();
            if (!store.settings().enabled || game == null || events <= 0) {
                return;
            }
            ReplayInfo info = new ReplayInfo();
            info.gameId = game.getId().toString();
            info.startedAt = startedAt;
            info.endedAt = System.currentTimeMillis();
            info.gameType = game.getGameType() == null ? null : game.getGameType().getName();
            if (table != null) {
                info.tableId = table.getId().toString();
                info.tableName = table.getName();
                info.deckType = table.getDeckType();
            }
            for (Player player : game.getPlayers().values()) {
                info.players.add(new ReplayInfo.ReplayPlayer(player.getName(), player.isHuman()));
            }
            info.result = result;
            info.turns = turns;
            info.events = events;
            info.truncated = events >= ReplaySettings.MAX_EVENTS_PER_GAME;
            store.complete(info);
        } catch (Throwable e) {
            logger.error("Can't list the replay of hosted game " + (game == null ? null : game.getId()), e);
        }
    }

    public String gameId() {
        return info.gameId;
    }

    /** a game log line, from the chat of a game being recorded */
    public static void onLog(UUID chatId, ChatMessage message) {
        ReplayRecorder recorder = chatId == null ? null : BY_CHAT.get(chatId);
        if (recorder != null) {
            recorder.log(message);
        }
    }

    /** a board snapshot, unless nothing changed since the last one; game thread only */
    public synchronized void frame() {
        frame(false);
    }

    private int frame(boolean always) {
        if (!canWrite()) {
            return -1;
        }
        try {
            // building a spectator's view costs far more than this key: skip it while nothing visible has changed
            String key = GameChangeKey.of(game);
            if (info.reviewVersion != null) {
                key += ReplayEvidence.knowledgeKey(game);
            }
            if (!always && key.equals(lastKey)) {
                return lastFrameCursor;
            }
            // written straight to text, {"view":...,"hands":{"name":...},"t":ms}: a JSON tree first would cost as
            // much again
            StringBuilder frame = new StringBuilder(32 * 1024).append("{\"view\":");
            GameView spectator = info.reviewVersion == null
                    ? new GameView(game.getState(), game, null, watcherId) : GameView.forReplay(game, null, watcherId);
            if (info.reviewVersion == null) {
                JsonCodec.GSON.toJson(spectator, frame);
            } else {
                JsonObject visible = ReplayEvidence.spectatorFrame(spectator);
                JsonCodec.GSON.toJson(visible, frame);
                frame.append(",\"review\":");
                JsonCodec.GSON.toJson(ReplayEvidence.protectedFrame(game, visible), frame);
            }
            frame.append(",\"hands\":{");
            boolean first = true;
            for (Player player : game.getPlayers().values()) {
                if (player.isHuman()) {
                    frame.append(first ? "" : ",").append(JsonCodec.GSON.toJson(player.getName())).append(':');
                    JsonCodec.GSON.toJson(new CardsView(game, player.getHand().getCards(game), player.getId()), frame);
                    first = false;
                }
            }
            frame.append('}');
            String snapshot = frame.toString();
            lastKey = key;
            if (snapshot.equals(lastFrame)) {
                return lastFrameCursor;
            }
            lastFrame = snapshot;
            lastFrameCursor = info.events;
            write(snapshot + ",\"t\":" + elapsed() + "}");
            return broken ? -1 : lastFrameCursor;
        } catch (Throwable e) {
            if (info.reviewVersion != null) {
                info.reviewIncomplete = true;
            }
            logger.warn("Replay of game " + info.gameId + " missed a snapshot (" + e.getClass().getSimpleName() + ')');
            return -1;
        }
    }

    private synchronized void log(ChatMessage message) {
        if (!canWrite() || (ProductGateway.enabled() && message.getMessageType() != ChatMessage.MessageType.GAME
                && message.getMessageType() != ChatMessage.MessageType.STATUS)) {
            return;
        }
        JsonObject event = new JsonObject();
        event.addProperty("t", elapsed());
        event.add("log", JsonCodec.GSON.toJsonTree(message));
        write(event.toString());
    }

    /** the game is over (or abandoned): the replay becomes available */
    public synchronized void finish(String result) {
        if (finished) {
            return;
        }
        if (result != null) {
            info.result = result;
        }
        frame(true);
        finished = true;
        if (decisionSubscription != null) {
            decisionSubscription.close();
        }
        if (chatId != null) {
            BY_CHAT.remove(chatId, this);
        }
        if (ProductGateway.enabled()) {
            BY_GAME.remove(game.getId(), this);
            Player startingPlayer = game.getStartingPlayerId() == null ? null : game.getPlayer(game.getStartingPlayerId());
            info.startPlayer = startingPlayer == null ? null : startingPlayer.getName();
            game.getPlayers().values().stream().filter(Player::hasWon).findFirst()
                    .ifPresent(winner -> info.winner = winner.getName());
            if (game.getMulligan() instanceof LondonMulligan) {
                LondonMulligan london = (LondonMulligan) game.getMulligan();
                for (ReplayInfo.ReplayPlayer replaySeat : info.players) {
                    game.getPlayers().values().stream().filter(player -> player.getName().equals(replaySeat.name)).findFirst()
                            .ifPresent(player -> replaySeat.mulligans = london.getMulliganCount(player.getId()));
                }
            }
        }
        info.endedAt = System.currentTimeMillis();
        info.turns = game.getTurnNum();
        boolean closed = true;
        try {
            out.close();
        } catch (IOException e) {
            logger.error("Can't close the replay of game " + info.gameId, e);
            closed = false;
        }
        // an unclosed gzip stream is unreadable: such a recording stays a .part file and is cleaned up later
        if (closed && info.events > 0) {
            store.complete(info);
        }
    }

    private boolean canWrite() {
        if (finished || broken) {
            return false;
        }
        if (info.events >= ReplaySettings.MAX_EVENTS_PER_GAME) {
            info.truncated = true;
            return false;
        }
        return true;
    }

    private void write(String event) {
        try {
            out.write(event);
            out.write('\n');
            info.events++;
        } catch (IOException e) {
            // nothing more can be written; finish() still lists what was recorded
            logger.error("Replay of game " + info.gameId + " stopped recording: " + e);
            info.truncated = true;
            broken = true;
        }
    }

    private long elapsed() {
        return System.currentTimeMillis() - info.startedAt;
    }
}
