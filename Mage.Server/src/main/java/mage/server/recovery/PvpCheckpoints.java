package mage.server.recovery;

import mage.game.Game;
import mage.game.GameOptions;
import mage.game.match.Match;
import mage.server.TableController;
import org.apache.log4j.Logger;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.sql.SQLException;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.stream.Collectors;
import java.util.stream.Stream;

/**
 * Opt-in PvP capture pilot. No restore/claim/join APIs: sessions are not durable product principals yet.
 * The synchronous callback shares GameSnapshot's existing start-of-turn boundary with solo saves.
 */
public final class PvpCheckpoints {
    private static final Logger logger = Logger.getLogger(PvpCheckpoints.class);
    private static final boolean ENABLED = "capture".equals(System.getenv("PLAYMAT_PVP_CHECKPOINTS"));
    private static volatile CheckpointStore store;
    private static String engine;
    private static boolean unavailable;

    private PvpCheckpoints() { }

    private static synchronized CheckpointStore store() throws IOException, SQLException {
        if (unavailable) return null;
        if (store == null) {
            try {
                engine = fingerprint(Paths.get("."));
                store = new CheckpointStore(Paths.get("db", "pvp-checkpoints.db"));
            } catch (IOException | SQLException | RuntimeException e) {
                unavailable = true;
                throw e;
            }
        }
        return store;
    }

    public static void prepareGame(TableController controller, GameOptions options) {
        if (!ENABLED || controller.getTable().isTournament() || controller.getTable().isTournamentSubTable()) return;
        Match match = controller.getMatch();
        // Rust-hosted lines and rollback branches need separate lifecycle integration. Never label them captured.
        if (match == null || match.getOptions().isRollbackTurnsAllowed() || match.getPlayers().size() != 2
                || match.getPlayers().stream().anyMatch(p -> !p.getPlayer().isHuman())
                || controller.getUserPlayerMap().size() != 2 || options.turnSnapshots != null) return;
        try {
            CheckpointStore target = store();
            if (target != null) attach(target, engine, controller.getTable().getId(), match,
                    new java.util.HashMap<>(controller.getUserPlayerMap()), options);
        } catch (IOException | SQLException | RuntimeException e) {
            // Log neither full state nor exception messages, which may contain private values.
            logger.warn("PvP checkpoint capture unavailable; recovery remains disabled");
        }
    }

    static void attach(CheckpointStore target, String engineVersion, UUID tableId, Match match,
                       Map<UUID, UUID> users, GameOptions options) {
        final UUID gameId = match.getGame().getId();
        options.turnSnapshots = snapshot -> {
            try {
                CheckpointContext context = new CheckpointContext(tableId, match, users, snapshot);
                target.commit(match.getId(), tableId, gameId, context.gameNumber, snapshot.getTurnNum(),
                        engineVersion, CheckpointContext.bytes(context), snapshot.toBytes());
                logger.debug("PvP checkpoint committed: match=" + match.getId() + " turn=" + snapshot.getTurnNum());
            } catch (IOException | SQLException | RuntimeException e) {
                // The last successfully committed row survives. Never acknowledge a failed/in-memory turn.
                logger.warn("PvP checkpoint commit failed: match=" + match.getId() + "; recovery remains disabled");
            }
        };
    }

    public static void gameEnded(Match match, Game game) {
        if (!ENABLED || store == null) return;
        try {
            store.gameEnded(match.getId(), game.getId(), match.hasEnded());
        } catch (SQLException | RuntimeException e) {
            logger.warn("PvP checkpoint lifecycle update failed: match=" + match.getId() + "; recovery remains disabled");
        }
    }

    /** Exact binary identity, including card/plugin jars. A Maven version alone does not imply compatibility. */
    static String fingerprint(Path root) throws IOException {
        Path extensions = root.resolve("extensions");
        if (Files.isDirectory(extensions)) {
            try (Stream<Path> paths = Files.list(extensions)) {
                if (paths.anyMatch(Files::isDirectory)) {
                    throw new IOException("Capture pilot does not support extension packages");
                }
            }
        }
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            int count = 0;
            for (String folder : new String[]{"lib", "plugins"}) {
                Path dir = root.resolve(folder);
                if (!Files.isDirectory(dir)) throw new IOException("Capture requires an assembled engine");
                List<Path> jars;
                try (Stream<Path> paths = Files.walk(dir)) {
                    jars = paths.filter(p -> p.toString().endsWith(".jar")).sorted().collect(Collectors.toList());
                }
                if (jars.isEmpty()) throw new IOException("Capture requires engine and plugin jars");
                for (Path jar : jars) {
                    digest.update(root.relativize(jar).toString().getBytes(StandardCharsets.UTF_8));
                    digest.update((byte) 0);
                    digest.update(java.nio.ByteBuffer.allocate(8).putLong(Files.size(jar)).array());
                    try (InputStream in = Files.newInputStream(jar)) {
                        byte[] buffer = new byte[65536];
                        for (int n; (n = in.read(buffer)) != -1;) digest.update(buffer, 0, n);
                    }
                    count++;
                }
            }
            StringBuilder hex = new StringBuilder("jars-v1:");
            for (byte b : digest.digest()) hex.append(String.format("%02x", b & 0xff));
            return hex + ":" + count;
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }
}
