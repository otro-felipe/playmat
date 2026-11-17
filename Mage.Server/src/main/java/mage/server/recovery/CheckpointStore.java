package mage.server.recovery;

import java.io.IOException;
import java.nio.channels.FileChannel;
import java.nio.channels.FileLock;
import java.nio.channels.OverlappingFileLockException;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.nio.file.attribute.PosixFilePermissions;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.sql.*;
import java.util.Arrays;
import java.util.UUID;

/** Private capture-only storage. Deliberately has no participant-facing read or resume API. */
public final class CheckpointStore implements AutoCloseable {
    static final int FORMAT = 1;
    private static final int MAX_BYTES = 64 * 1024 * 1024;
    private final Connection db;
    private final FileChannel lockChannel;
    private final FileLock lock;

    public CheckpointStore(Path file) throws IOException, SQLException {
        Files.createDirectories(file.toAbsolutePath().getParent());
        Path lockFile = file.resolveSibling(file.getFileName() + ".lock");
        privateFile(lockFile);
        lockChannel = FileChannel.open(lockFile, StandardOpenOption.WRITE);
        FileLock acquired;
        try {
            acquired = lockChannel.tryLock();
        } catch (OverlappingFileLockException e) {
            acquired = null;
        } catch (IOException | RuntimeException e) {
            lockChannel.close();
            throw e;
        }
        if (acquired == null) {
            lockChannel.close();
            throw new IOException("Checkpoint store already owned by another engine");
        }
        lock = acquired;
        Connection opened = null;
        try {
            privateFile(file);
            opened = DriverManager.getConnection("jdbc:sqlite:" + file.toAbsolutePath());
            try (Statement s = opened.createStatement()) {
                s.execute("PRAGMA busy_timeout=5000");
                s.execute("PRAGMA journal_mode=DELETE");
                s.execute("PRAGMA synchronous=FULL");
                try (ResultSet version = s.executeQuery("PRAGMA user_version")) {
                    if (version.next() && version.getInt(1) > FORMAT) {
                        throw new SQLException("Unsupported checkpoint database version");
                    }
                }
                s.execute("CREATE TABLE IF NOT EXISTS checkpoints (match_id TEXT PRIMARY KEY, table_id TEXT NOT NULL,"
                        + " game_id TEXT NOT NULL, game_number INTEGER NOT NULL, turn INTEGER NOT NULL,"
                        + " revision INTEGER NOT NULL, committed_at INTEGER NOT NULL, status TEXT NOT NULL,"
                        + " format INTEGER NOT NULL, engine TEXT NOT NULL, checksum BLOB NOT NULL,"
                        + " context BLOB NOT NULL, snapshot BLOB NOT NULL)");
                s.execute("PRAGMA user_version=" + FORMAT);
            }
            db = opened;
        } catch (IOException | SQLException | RuntimeException e) {
            if (opened != null) opened.close();
            lock.release();
            lockChannel.close();
            throw e;
        }
    }

    private static void privateFile(Path path) throws IOException {
        if (Files.isSymbolicLink(path)) throw new IOException("Checkpoint files must not be symlinks");
        try {
            if (!Files.exists(path, LinkOption.NOFOLLOW_LINKS)) {
                Files.createFile(path, PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rw-------")));
            }
            Files.setPosixFilePermissions(path, PosixFilePermissions.fromString("rw-------"));
        } catch (UnsupportedOperationException e) {
            // This pilot must not silently create world-readable hidden information on another filesystem.
            throw new IOException("Checkpoint capture requires owner-only POSIX file permissions", e);
        }
    }

    /** Returns only after SQLite's FULL synchronous commit. No queued or in-memory checkpoint is confirmed. */
    public synchronized void commit(UUID matchId, UUID tableId, UUID gameId, int gameNumber, int turn,
                                    String engine, byte[] context, byte[] snapshot) throws SQLException {
        if (matchId == null || tableId == null || gameId == null || gameNumber < 1 || turn < 1
                || engine == null || engine.isEmpty() || context == null || snapshot == null
                || context.length == 0 || snapshot.length == 0
                || context.length > MAX_BYTES || snapshot.length > MAX_BYTES) {
            throw new IllegalArgumentException("Invalid checkpoint envelope");
        }
        try (PreparedStatement s = db.prepareStatement(
                "INSERT INTO checkpoints VALUES (?,?,?,?,?,1,?,'capture_only',?,?,?,?,?)"
                        + " ON CONFLICT(match_id) DO UPDATE SET table_id=excluded.table_id, game_id=excluded.game_id,"
                        + " game_number=excluded.game_number, turn=excluded.turn, revision=checkpoints.revision+1,"
                        + " committed_at=excluded.committed_at,status='capture_only',format=excluded.format,"
                        + " engine=excluded.engine,checksum=excluded.checksum,context=excluded.context,snapshot=excluded.snapshot"
                        + " WHERE checkpoints.table_id=excluded.table_id AND ("
                        + " (checkpoints.status='capture_only' AND checkpoints.game_id=excluded.game_id"
                        + " AND checkpoints.game_number=excluded.game_number AND excluded.turn>=checkpoints.turn)"
                        + " OR (checkpoints.status='between_games' AND checkpoints.game_id<>excluded.game_id"
                        + " AND excluded.game_number=checkpoints.game_number+1))")) {
            s.setString(1, matchId.toString());
            s.setString(2, tableId.toString());
            s.setString(3, gameId.toString());
            s.setInt(4, gameNumber);
            s.setInt(5, turn);
            s.setLong(6, System.currentTimeMillis());
            s.setInt(7, FORMAT);
            s.setString(8, engine);
            s.setBytes(9, checksum(context, snapshot));
            s.setBytes(10, context);
            s.setBytes(11, snapshot);
            if (s.executeUpdate() != 1) throw new SQLException("Checkpoint does not follow the current match generation");
        }
    }

    /** Prevents an ended game's turn from being mistaken for the current match state. */
    public synchronized void gameEnded(UUID matchId, UUID gameId, boolean completed) throws SQLException {
        try (PreparedStatement s = db.prepareStatement(
                "UPDATE checkpoints SET status=?,revision=revision+1 WHERE match_id=? AND game_id=?"
                        + " AND status<>'completed' AND status<>?")) {
            String status = completed ? "completed" : "between_games";
            s.setString(1, status);
            s.setString(2, matchId.toString());
            s.setString(3, gameId.toString());
            s.setString(4, status);
            s.executeUpdate();
        }
    }

    /** Package-private diagnostics for tests/future trusted adapter. Never deserialize before these checks. */
    synchronized Captured inspect(UUID matchId, String exactEngine) throws SQLException {
        try (PreparedStatement s = db.prepareStatement("SELECT * FROM checkpoints WHERE match_id=?")) {
            s.setString(1, matchId.toString());
            try (ResultSet r = s.executeQuery()) {
                if (!r.next()) return null;
                if (r.getInt("format") != FORMAT || !r.getString("engine").equals(exactEngine)) {
                    throw new IllegalStateException("Checkpoint requires its exact engine and format version");
                }
                byte[] context = r.getBytes("context");
                byte[] snapshot = r.getBytes("snapshot");
                if (!Arrays.equals(r.getBytes("checksum"), checksum(context, snapshot))) {
                    throw new IllegalStateException("Checkpoint integrity check failed");
                }
                return new Captured(r.getInt("turn"), r.getLong("revision"), r.getString("status"), context, snapshot);
            }
        }
    }

    static final class Captured {
        final int turn;
        final long revision;
        final String status;
        final byte[] context;
        final byte[] snapshot;

        Captured(int turn, long revision, String status, byte[] context, byte[] snapshot) {
            this.turn = turn;
            this.revision = revision;
            this.status = status;
            this.context = context;
            this.snapshot = snapshot;
        }
    }

    private static byte[] checksum(byte[] context, byte[] snapshot) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            // Length framing prevents moving a prefix from the snapshot into the context unnoticed.
            digest.update(java.nio.ByteBuffer.allocate(8).putInt(context.length).putInt(snapshot.length).array());
            digest.update(context);
            return digest.digest(snapshot);
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    @Override
    public synchronized void close() throws SQLException, IOException {
        try {
            db.close();
        } finally {
            try { lock.release(); } finally { lockChannel.close(); }
        }
    }
}
