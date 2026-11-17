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

/** Private checkpoint storage and recovery claims. Serialized payloads are never participant-facing responses. */
public final class CheckpointStore implements AutoCloseable {
    static final int FORMAT = 1;
    private static final int DATABASE_FORMAT = 2;
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
                    if (version.next() && version.getInt(1) > DATABASE_FORMAT) {
                        throw new SQLException("Unsupported checkpoint database version");
                    }
                }
                s.execute("CREATE TABLE IF NOT EXISTS checkpoints (match_id TEXT PRIMARY KEY, table_id TEXT NOT NULL,"
                        + " game_id TEXT NOT NULL, game_number INTEGER NOT NULL, turn INTEGER NOT NULL,"
                        + " revision INTEGER NOT NULL, committed_at INTEGER NOT NULL, status TEXT NOT NULL,"
                        + " format INTEGER NOT NULL, engine TEXT NOT NULL, checksum BLOB NOT NULL,"
                        + " context BLOB NOT NULL, snapshot BLOB NOT NULL)");
                s.execute("CREATE TABLE IF NOT EXISTS recovery_participants (match_id TEXT NOT NULL, account_id TEXT NOT NULL,"
                        + " seat_id TEXT NOT NULL, consent_revision INTEGER, PRIMARY KEY(match_id, account_id, seat_id))");
                s.execute("CREATE TABLE IF NOT EXISTS recovery_claims (match_id TEXT PRIMARY KEY, generation INTEGER NOT NULL DEFAULT 0,"
                        + " status TEXT NOT NULL, boot_id TEXT NOT NULL, claim TEXT, table_id TEXT, game_id TEXT, failure TEXT)");
                s.execute("CREATE TABLE IF NOT EXISTS recovery_mappings (match_id TEXT NOT NULL, generation INTEGER NOT NULL,"
                        + " original_table_id TEXT NOT NULL, table_id TEXT NOT NULL, original_game_id TEXT NOT NULL, game_id TEXT NOT NULL,"
                        + " game_number INTEGER NOT NULL, PRIMARY KEY(match_id,generation,game_id))");
                s.execute("PRAGMA user_version=" + DATABASE_FORMAT);
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
        commit(matchId, tableId, gameId, gameNumber, turn, engine, context, snapshot, false);
    }

    private void commit(UUID matchId, UUID tableId, UUID gameId, int gameNumber, int turn,
                        String engine, byte[] context, byte[] snapshot, boolean recovery) throws SQLException {
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
                        + " WHERE checkpoints.table_id=excluded.table_id AND checkpoints.status<>'completed' AND (?=1 OR ("
                        + " (checkpoints.status='capture_only' AND checkpoints.game_id=excluded.game_id"
                        + " AND checkpoints.game_number=excluded.game_number AND excluded.turn>=checkpoints.turn)"
                        + " OR (checkpoints.status='between_games' AND checkpoints.game_id<>excluded.game_id"
                        + " AND excluded.game_number=checkpoints.game_number+1)))")) {
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
            s.setInt(12, recovery ? 1 : 0);
            if (s.executeUpdate() != 1) throw new SQLException("Checkpoint does not follow the current match generation");
        }
    }

    /** Acquired with the process file lock: previous live/restoring owners are dead; acknowledgments never survive a boot. */
    synchronized void boot(String bootId) throws SQLException {
        transaction(() -> {
            try (Statement s = db.createStatement()) {
                s.executeUpdate("UPDATE recovery_claims SET status='waiting',claim=NULL,table_id=NULL,game_id=NULL"
                        + " WHERE status IN ('live','restoring')");
                s.executeUpdate("UPDATE recovery_participants SET consent_revision=NULL");
            }
            return null;
        });
    }

    synchronized void saveRecoverable(CheckpointContext context, byte[] snapshot, String engine, String bootId,
                                     UUID liveTable, UUID liveGame) throws SQLException, IOException {
        byte[] bytes = CheckpointContext.bytes(context);
        transaction(() -> {
            Claim owner = claim(context.matchId);
            if (owner != null && (!bootId.equals(owner.bootId) || !"live".equals(owner.status)
                    || !liveTable.toString().equals(owner.tableId))) throw new SQLException("Stale recovery owner");
            int participants = 0;
            for (CheckpointContext.Seat seat : context.seats) {
                if (seat.principal == null) throw new SQLException("Missing durable seat identity");
                try (PreparedStatement s = db.prepareStatement("INSERT OR IGNORE INTO recovery_participants(match_id,account_id,seat_id) VALUES(?,?,?)")) {
                    s.setString(1, context.matchId.toString()); s.setString(2, seat.principal.accountId.toString());
                    s.setString(3, seat.principal.seatId); s.executeUpdate();
                }
                if (!participant(context.matchId, seat.principal)) throw new SQLException("Participant mismatch");
                participants++;
            }
            try (PreparedStatement s = db.prepareStatement("SELECT COUNT(*) FROM recovery_participants WHERE match_id=?")) {
                s.setString(1, context.matchId.toString());
                try (ResultSet r = s.executeQuery()) { if (!r.next() || r.getInt(1) != 2 || participants != 2) throw new SQLException("Participant mismatch"); }
            }
            commit(context.matchId, context.tableId, context.gameId, context.gameNumber,
                    Math.max(1, context.phase.equals("turn") ? context.turn : 1), engine, bytes, snapshot, true);
            try (PreparedStatement s = db.prepareStatement("INSERT INTO recovery_claims(match_id,status,boot_id,table_id,game_id)"
                    + " VALUES(?,'live',?,?,?) ON CONFLICT(match_id) DO UPDATE SET game_id=excluded.game_id")) {
                s.setString(1, context.matchId.toString()); s.setString(2, bootId);
                s.setString(3, liveTable.toString()); s.setString(4, liveGame.toString()); s.executeUpdate();
            }
            long generation = owner == null ? 0 : owner.generation;
            String originalGame = context.gameId.toString();
            try (PreparedStatement s = db.prepareStatement("SELECT original_game_id FROM recovery_mappings WHERE match_id=? AND game_number=? ORDER BY generation LIMIT 1")) {
                s.setString(1, context.matchId.toString()); s.setInt(2, context.gameNumber);
                try (ResultSet r = s.executeQuery()) { if (r.next()) originalGame = r.getString(1); }
            }
            try (PreparedStatement s = db.prepareStatement("INSERT OR IGNORE INTO recovery_mappings VALUES(?,?,?,?,?,?,?)")) {
                s.setString(1, context.matchId.toString()); s.setLong(2, generation); s.setString(3, context.tableId.toString());
                s.setString(4, liveTable.toString()); s.setString(5, originalGame); s.setString(6, liveGame.toString());
                s.setInt(7, context.gameNumber); s.executeUpdate();
            }
            return null;
        });
    }

    synchronized boolean participant(UUID id, RecoveryPrincipal principal) throws SQLException {
        if (principal == null) return false;
        try (PreparedStatement s = db.prepareStatement("SELECT 1 FROM recovery_participants WHERE match_id=? AND account_id=? AND seat_id=?")) {
            s.setString(1, id.toString()); s.setString(2, principal.accountId.toString()); s.setString(3, principal.seatId);
            try (ResultSet r = s.executeQuery()) { return r.next(); }
        }
    }

    synchronized java.util.List<UUID> matches(RecoveryPrincipal principal) throws SQLException {
        java.util.List<UUID> ids = new java.util.ArrayList<>();
        try (PreparedStatement s = db.prepareStatement("SELECT match_id FROM recovery_participants WHERE account_id=? AND seat_id=?")) {
            s.setString(1, principal.accountId.toString()); s.setString(2, principal.seatId);
            try (ResultSet r = s.executeQuery()) { while (r.next()) ids.add(UUID.fromString(r.getString(1))); }
        }
        return ids;
    }

    synchronized void consent(UUID id, RecoveryPrincipal principal, long revision) throws SQLException {
        try (PreparedStatement s = db.prepareStatement("UPDATE recovery_participants SET consent_revision=?"
                + " WHERE match_id=? AND account_id=? AND seat_id=? AND EXISTS(SELECT 1 FROM checkpoints WHERE match_id=? AND revision=?)")) {
            s.setLong(1, revision); s.setString(2, id.toString()); s.setString(3, principal.accountId.toString());
            s.setString(4, principal.seatId); s.setString(5, id.toString()); s.setLong(6, revision);
            if (s.executeUpdate() != 1) throw new SQLException("The confirmed checkpoint changed; read it again");
        }
    }

    synchronized String acquire(UUID id, long revision, String bootId) throws SQLException {
        return transaction(() -> {
            try (PreparedStatement s = db.prepareStatement("SELECT COUNT(*) FROM recovery_participants WHERE match_id=? AND consent_revision=?")) {
                s.setString(1, id.toString()); s.setLong(2, revision);
                try (ResultSet r = s.executeQuery()) { if (!r.next() || r.getInt(1) != 2) return null; }
            }
            String token = UUID.randomUUID().toString();
            try (PreparedStatement s = db.prepareStatement("UPDATE recovery_claims SET status='restoring',generation=generation+1,boot_id=?,claim=?"
                    + " WHERE match_id=? AND status='waiting' AND EXISTS(SELECT 1 FROM checkpoints WHERE match_id=? AND revision=?)")) {
                s.setString(1, bootId); s.setString(2, token); s.setString(3, id.toString()); s.setString(4, id.toString()); s.setLong(5, revision);
                return s.executeUpdate() == 1 ? token : null;
            }
        });
    }

    synchronized void activate(UUID id, String token, UUID table, UUID game) throws SQLException {
        try (PreparedStatement s = db.prepareStatement("UPDATE recovery_claims SET status='live',table_id=?,game_id=? WHERE match_id=? AND claim=? AND status='restoring'")) {
            s.setString(1, table.toString()); s.setString(2, game.toString()); s.setString(3, id.toString()); s.setString(4, token);
            if (s.executeUpdate() != 1) throw new SQLException("Recovery claim is no longer current");
        }
    }

    synchronized void liveGame(UUID id, UUID table, UUID game, String bootId) throws SQLException {
        try (PreparedStatement s = db.prepareStatement("UPDATE recovery_claims SET game_id=? WHERE match_id=? AND table_id=? AND boot_id=? AND status='live'")) {
            s.setString(1, game.toString()); s.setString(2, id.toString()); s.setString(3, table.toString()); s.setString(4, bootId);
            if (s.executeUpdate()!=1) throw new SQLException("Stale live game mapping");
        }
    }

    synchronized String originalGame(UUID id, int number) throws SQLException {
        try (PreparedStatement s = db.prepareStatement("SELECT original_game_id FROM recovery_mappings WHERE match_id=? AND game_number=? ORDER BY generation LIMIT 1")) {
            s.setString(1,id.toString());s.setInt(2,number);
            try(ResultSet r=s.executeQuery()){ return r.next()?r.getString(1):null; }
        }
    }

    synchronized String originalTable(UUID id) throws SQLException {
        try (PreparedStatement s=db.prepareStatement("SELECT table_id FROM checkpoints WHERE match_id=?")) {
            s.setString(1,id.toString());
            try(ResultSet r=s.executeQuery()){return r.next()?r.getString(1):null;}
        }
    }

    synchronized void finish(UUID id, String status) throws SQLException {
        if (!java.util.Arrays.asList("completed", "failed").contains(status)) throw new IllegalArgumentException();
        try (PreparedStatement s = db.prepareStatement("UPDATE recovery_claims SET status=? WHERE match_id=? AND status<>'completed'")) {
            s.setString(1, status); s.setString(2, id.toString()); s.executeUpdate();
        }
    }

    synchronized Claim claim(UUID id) throws SQLException {
        try (PreparedStatement s = db.prepareStatement("SELECT * FROM recovery_claims WHERE match_id=?")) {
            s.setString(1, id.toString());
            try (ResultSet r = s.executeQuery()) { return !r.next() ? null : new Claim(r.getString("status"),r.getString("boot_id"),r.getString("table_id"),r.getString("game_id"),r.getLong("generation")); }
        }
    }

    static final class Claim {
        final String status, bootId, tableId, gameId;
        final long generation;
        Claim(String status, String bootId, String tableId, String gameId, long generation) {
            this.status=status; this.bootId=bootId; this.tableId=tableId; this.gameId=gameId; this.generation=generation;
        }
    }

    private interface SqlWork<T> { T run() throws SQLException; }
    private <T> T transaction(SqlWork<T> work) throws SQLException {
        db.setAutoCommit(false);
        try { T result = work.run(); db.commit(); return result; }
        catch (SQLException | RuntimeException e) { db.rollback(); throw e; }
        finally { db.setAutoCommit(true); }
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
