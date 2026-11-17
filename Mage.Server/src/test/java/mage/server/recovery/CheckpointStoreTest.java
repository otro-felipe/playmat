package mage.server.recovery;

import mage.abilities.effects.common.continuous.BoostAllEffect;
import mage.cards.Card;
import mage.cards.CardSetInfo;
import mage.cards.basiclands.Forest;
import mage.cards.basiclands.Island;
import mage.cards.basiclands.Mountain;
import mage.cards.decks.Deck;
import mage.constants.Duration;
import mage.constants.RangeOfInfluence;
import mage.constants.Rarity;
import mage.game.Game;
import mage.game.GameOptions;
import mage.game.GameSnapshot;
import mage.game.GameState;
import mage.game.match.Match;
import mage.game.match.MatchOptions;
import mage.players.Player;
import mage.util.GameRandom;
import mage.watchers.common.SpellsCastWatcher;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.lang.reflect.Field;
import java.nio.file.*;
import java.nio.file.attribute.PosixFilePermissions;
import java.sql.*;
import java.util.*;
import java.util.concurrent.TimeUnit;
import java.util.stream.Collectors;

import static org.junit.jupiter.api.Assertions.*;

public class CheckpointStoreTest {
    @TempDir Path dir;
    static final String ENGINE = "isolated-fixture-engine-v1";
    static final UUID MATCH = UUID.fromString("00000000-0000-0000-0000-000000000001");
    static final UUID TABLE = UUID.fromString("00000000-0000-0000-0000-000000000002");
    static final UUID GAME = UUID.fromString("00000000-0000-0000-0000-000000000003");

    @Test
    void commitsArePrivateAtomicAndVersionChecked() throws Exception {
        Path path = dir.resolve("checkpoint.db");
        try (CheckpointStore store = new CheckpointStore(path)) {
            assertNull(store.inspect(MATCH, ENGINE));
            store.commit(MATCH, TABLE, GAME, 1, 7, ENGINE, new byte[]{1, 2}, new byte[]{3, 4});
            assertEquals(7, store.inspect(MATCH, ENGINE).turn);
            assertEquals(1, store.inspect(MATCH, ENGINE).revision);
            assertThrows(IllegalStateException.class, () -> store.inspect(MATCH, "another-engine"));
            assertThrows(IOException.class, () -> new CheckpointStore(path), "second engine cannot own the same store");
            assertEquals(PosixFilePermissions.fromString("rw-------"), Files.getPosixFilePermissions(path));
            assertThrows(IllegalArgumentException.class,
                    () -> store.commit(MATCH, TABLE, GAME, 1, 8, ENGINE, new byte[0], new byte[]{9}));
            assertArrayEquals(new byte[]{3, 4}, store.inspect(MATCH, ENGINE).snapshot);
        }
        try (CheckpointStore reopened = new CheckpointStore(path)) {
            assertEquals(7, reopened.inspect(MATCH, ENGINE).turn);
            reopened.gameEnded(MATCH, UUID.randomUUID(), true);
            assertEquals("capture_only", reopened.inspect(MATCH, ENGINE).status, "stale end event is ignored");
            reopened.gameEnded(MATCH, GAME, false);
            assertEquals("between_games", reopened.inspect(MATCH, ENGINE).status);
            assertThrows(SQLException.class, () -> reopened.commit(MATCH, TABLE, GAME, 1, 8, ENGINE, new byte[]{5}, new byte[]{6}));
            reopened.commit(MATCH, TABLE, UUID.randomUUID(), 2, 1, ENGINE, new byte[]{5}, new byte[]{6});
            assertEquals("capture_only", reopened.inspect(MATCH, ENGINE).status);
            reopened.gameEnded(MATCH, GAME, true);
            assertEquals("capture_only", reopened.inspect(MATCH, ENGINE).status);
        }
    }

    @Test
    void completedMatchesCannotBeResurrected() throws Exception {
        try (CheckpointStore store = new CheckpointStore(dir.resolve("checkpoint.db"))) {
            store.commit(MATCH, TABLE, GAME, 1, 4, ENGINE, new byte[]{1}, new byte[]{2});
            store.gameEnded(MATCH, GAME, true);
            store.gameEnded(MATCH, GAME, false);
            assertThrows(SQLException.class, () -> store.commit(MATCH, TABLE, GAME, 1, 5, ENGINE, new byte[]{3}, new byte[]{4}));
            assertEquals("completed", store.inspect(MATCH, ENGINE).status);
            assertEquals(4, store.inspect(MATCH, ENGINE).turn);
        }
    }

    @Test
    void lateOrOutOfOrderCallbacksCannotReplaceTheCurrentGame() throws Exception {
        try (CheckpointStore store = new CheckpointStore(dir.resolve("checkpoint.db"))) {
            store.commit(MATCH, TABLE, GAME, 1, 4, ENGINE, new byte[]{1}, new byte[]{2});
            assertThrows(SQLException.class, () -> store.commit(MATCH, TABLE, GAME, 1, 3, ENGINE, new byte[]{9}, new byte[]{9}));
            assertThrows(SQLException.class, () -> store.commit(MATCH, UUID.randomUUID(), GAME, 1, 5, ENGINE, new byte[]{9}, new byte[]{9}));
            store.gameEnded(MATCH, GAME, false);
            UUID nextGame = UUID.randomUUID();
            store.commit(MATCH, TABLE, nextGame, 2, 1, ENGINE, new byte[]{3}, new byte[]{4});
            assertThrows(SQLException.class, () -> store.commit(MATCH, TABLE, GAME, 1, 5, ENGINE, new byte[]{9}, new byte[]{9}));
            store.gameEnded(MATCH, GAME, true);
            assertEquals("capture_only", store.inspect(MATCH, ENGINE).status);
            assertArrayEquals(new byte[]{4}, store.inspect(MATCH, ENGINE).snapshot);
        }
    }

    @Test
    void corruptionAndFutureFormatsFailBeforeDeserialization() throws Exception {
        Path path = dir.resolve("checkpoint.db");
        try (CheckpointStore store = new CheckpointStore(path)) {
            store.commit(MATCH, TABLE, GAME, 1, 4, ENGINE, new byte[]{1}, new byte[]{2});
            try (Connection db = DriverManager.getConnection("jdbc:sqlite:" + path); Statement s = db.createStatement()) {
                s.executeUpdate("UPDATE checkpoints SET format=999");
                assertThrows(IllegalStateException.class, () -> store.inspect(MATCH, ENGINE));
                s.executeUpdate("UPDATE checkpoints SET format=1,snapshot=X'03'");
                assertThrows(IllegalStateException.class, () -> store.inspect(MATCH, ENGINE));
            }
        }
        try (Connection db = DriverManager.getConnection("jdbc:sqlite:" + path); Statement s = db.createStatement()) {
            s.execute("PRAGMA user_version=999");
        }
        assertThrows(SQLException.class, () -> new CheckpointStore(path));
    }

    @Test
    void symlinksAreRejectedAndFingerprintsCoverCardAndPluginBinaries() throws Exception {
        Path target = dir.resolve("target");
        Files.write(target, new byte[]{1});
        Path link = dir.resolve("link");
        Files.createSymbolicLink(link, target);
        assertThrows(IOException.class, () -> new CheckpointStore(link));
        Files.createDirectories(dir.resolve("lib"));
        Files.createDirectories(dir.resolve("plugins"));
        Files.write(dir.resolve("lib/cards.jar"), new byte[]{1});
        Files.write(dir.resolve("plugins/human.jar"), new byte[]{2});
        String first = PvpCheckpoints.fingerprint(dir);
        assertEquals(first, PvpCheckpoints.fingerprint(dir));
        Files.write(dir.resolve("lib/cards.jar"), new byte[]{3});
        assertNotEquals(first, PvpCheckpoints.fingerprint(dir));
        String second = PvpCheckpoints.fingerprint(dir);
        Files.write(dir.resolve("plugins/human.jar"), new byte[]{4});
        assertNotEquals(second, PvpCheckpoints.fingerprint(dir));
        Files.createDirectories(dir.resolve("extensions/custom"));
        assertThrows(IOException.class, () -> PvpCheckpoints.fingerprint(dir));
    }

    @Test
    void capturesTwoHumanSeatsWithoutChangingLiveConfiguration() throws Exception {
        try (CheckpointStore store = new CheckpointStore(dir.resolve("checkpoint.db"))) {
            fixture(store);
        }
    }

    @Test
    void humanSeatCheckpointSurvivesARealProcessKillAndAnotherJvmCanReadIt() throws Exception {
        Path path = dir.resolve("checkpoint.db");
        Process writer = child("capture", path);
        try {
            awaitReady(writer);
            assertTrue(writer.isAlive());
        } finally {
            writer.destroyForcibly();
            assertTrue(writer.waitFor(15, TimeUnit.SECONDS));
        }
        // A completely fresh JVM deserializes cards, humans, effects, exile and RNG after the writer is dead.
        Process reader = child("verify", path);
        assertTrue(reader.waitFor(30, TimeUnit.SECONDS));
        assertEquals(0, reader.exitValue(), "fresh JVM verifier: " + new String(Files.readAllBytes(dir.resolve("verify.log"))));
    }

    @Test
    void killedUncommittedSqliteWriteKeepsTheLastConfirmedTurn() throws Exception {
        Path path = dir.resolve("checkpoint.db");
        try (CheckpointStore store = new CheckpointStore(path)) {
            store.commit(MATCH, TABLE, GAME, 1, 7, ENGINE, new byte[]{1, 2}, new byte[]{3, 4});
        }
        Process writer = child("uncommitted", path);
        try {
            awaitReady(writer);
            assertThrows(IOException.class, () -> new CheckpointStore(path), "other JVM's writer lock");
            assertTrue(Files.size(Paths.get(path + "-journal")) > 0, "uncommitted write has a rollback journal on disk");
            assertEquals(PosixFilePermissions.fromString("rw-------"), Files.getPosixFilePermissions(Paths.get(path + "-journal")));
        } finally {
            writer.destroyForcibly();
            assertTrue(writer.waitFor(15, TimeUnit.SECONDS));
        }
        try (CheckpointStore reopened = new CheckpointStore(path)) {
            CheckpointStore.Captured confirmed = reopened.inspect(MATCH, ENGINE);
            assertEquals(7, confirmed.turn);
            assertEquals(1, confirmed.revision);
            assertArrayEquals(new byte[]{1, 2}, confirmed.context);
            assertArrayEquals(new byte[]{3, 4}, confirmed.snapshot);
        }
    }

    private Process child(String mode, Path path) throws IOException {
        String cp = System.getProperty("surefire.test.class.path", System.getProperty("java.class.path"));
        return new ProcessBuilder(Paths.get(System.getProperty("java.home"), "bin", "java").toString(),
                "-Dh2.bindAddress=127.0.0.1", "-cp", cp, CheckpointStoreTest.class.getName(), mode, path.toString(), dir.resolve("ready").toString())
                .redirectErrorStream(true).redirectOutput(dir.resolve(mode + ".log").toFile()).start();
    }

    private void awaitReady(Process process) throws Exception {
        long until = System.nanoTime() + TimeUnit.SECONDS.toNanos(30);
        while (!Files.exists(dir.resolve("ready")) && process.isAlive() && System.nanoTime() < until) Thread.sleep(25);
        String diagnostics = Files.exists(dir.resolve("capture.log")) ? new String(Files.readAllBytes(dir.resolve("capture.log"))) : "";
        assertTrue(Files.exists(dir.resolve("ready")), "child reached the intended crash boundary: " + diagnostics);
    }

    public static void main(String[] args) throws Exception {
        Path path = Paths.get(args[1]);
        try (CheckpointStore store = new CheckpointStore(path)) {
            if (args[0].equals("verify")) {
                // The match's original public IDs are recorded inside the private context, not generated on read.
                try (Connection db = DriverManager.getConnection("jdbc:sqlite:" + path);
                     Statement s = db.createStatement(); ResultSet rows = s.executeQuery("SELECT match_id FROM checkpoints")) {
                    if (!rows.next()) throw new AssertionError("no checkpoint");
                    verify(store.inspect(UUID.fromString(rows.getString(1)), ENGINE));
                }
                return;
            }
            if (args[0].equals("capture")) {
                fixture(store);
            } else if (args[0].equals("uncommitted")) {
                try (Connection db = DriverManager.getConnection("jdbc:sqlite:" + path)) {
                    db.setAutoCommit(false);
                    try (Statement s = db.createStatement()) {
                        s.executeUpdate("UPDATE checkpoints SET turn=8,context=randomblob(8388608),snapshot=randomblob(8388608)");
                    }
                    // The resource stays open until SIGKILL. No orderly close or GC rollback can fake recovery.
                    awaitKilled(Paths.get(args[2]));
                }
                return;
            } else throw new IllegalArgumentException("Unknown child mode");
            awaitKilled(Paths.get(args[2]));
        }
    }

    private static void awaitKilled(Path ready) throws Exception {
        Files.write(ready, new byte[]{1});
        new java.util.concurrent.CountDownLatch(1).await();
    }

    static UUID fixture(CheckpointStore store) throws Exception {
        MatchOptions options = new MatchOptions("private fixture", "Two Player Duel", false);
        options.setWinsNeeded(2);
        options.setPassword("fixture-table-secret");
        Match match = (Match) Class.forName("mage.game.TwoPlayerMatch").getConstructor(MatchOptions.class).newInstance(options);
        Map<UUID, UUID> users = new LinkedHashMap<>();
        for (String name : new String[]{"HumanFixture", "mcp_fixture"}) {
            Player human = (Player) Class.forName("mage.player.human.HumanPlayer")
                    .getConstructor(String.class, RangeOfInfluence.class, int.class).newInstance(name, RangeOfInfluence.ALL, 1);
            match.addPlayer(human, new Deck());
            users.put(UUID.randomUUID(), human.getId());
        }
        match.startGame();
        match.getPlayers().get(0).addWin();
        match.getPlayers().forEach(player -> player.setPriorityTimeLeft(456));
        match.addDraw();
        Game game = match.getGame();
        GameState state = game.getState();
        state.setTurnNum(7);
        state.setActivePlayerId(match.getPlayers().get(0).getPlayer().getId());
        GameRandom random = new GameRandom(77);
        for (int i = 0; i < 7; i++) random.nextInt();
        state.setRandom(random);
        Map<UUID, Card> cards = new LinkedHashMap<>();
        for (Player player : state.getPlayers().values()) {
            player.setPriorityTimeLeft(123);
            player.setBufferTimeLeft(9);
            List<Card> ordered = Arrays.asList(new Forest(player.getId(), info("Forest")),
                    new Island(player.getId(), info("Island")), new Mountain(player.getId(), info("Mountain")));
            game.loadCards(new LinkedHashSet<>(ordered), player.getId());
            ordered.forEach(card -> cards.put(card.getId(), card));
            ordered.forEach(card -> player.getLibrary().putOnBottom(card, game));
            Card hand = new Island(player.getId(), info("Island"));
            cards.put(hand.getId(), hand);
            player.getHand().add(hand);
            Card exile = new Mountain(player.getId(), info("Mountain"));
            cards.put(exile.getId(), exile);
            state.getExile().add(exile);
            match.getPlayer(player.getId()).getDeck().getSideboard().add(new Forest(player.getId(), info("Forest")));
        }
        Card source = cards.values().iterator().next();
        state.getContinuousEffects().addEffect(new BoostAllEffect(2, 3, Duration.EndOfGame), source.getAbilities().get(0));
        SpellsCastWatcher watcher = state.getWatcher(SpellsCastWatcher.class);
        Field cast = SpellsCastWatcher.class.getDeclaredField("nonCreatureSpells");
        cast.setAccessible(true);
        cast.setInt(watcher, 3);
        GameOptions capture = new GameOptions();
        PvpCheckpoints.attach(store, ENGINE, TABLE, match, users, capture);
        capture.turnSnapshots.accept(GameSnapshot.of(state, cards, Collections.emptyMap(), state.getActivePlayerId()));
        assertEquals("fixture-table-secret", options.getPassword(), "live configuration remains unchanged");
        verify(store.inspect(match.getId(), ENGINE));
        return match.getId();
    }

    private static CardSetInfo info(String name) { return new CardSetInfo(name, "TST", "1", Rarity.COMMON); }

    static void verify(CheckpointStore.Captured row) throws Exception {
        assertNotNull(row);
        assertEquals(7, row.turn);
        assertEquals("capture_only", row.status);
        CheckpointContext context = (CheckpointContext) CheckpointContext.read(row.context);
        assertEquals(TABLE, context.tableId);
        assertEquals(1, context.gameNumber);
        assertEquals(1, context.draws);
        assertEquals(2, context.options.getWinsNeeded());
        assertEquals("", context.options.getPassword());
        assertEquals(2, context.seats.size());
        assertEquals(1, context.seats.stream().mapToInt(s -> s.wins).sum());
        GameSnapshot.Restored restored = GameSnapshot.fromBytes(row.snapshot).restore();
        for (CheckpointContext.Seat seat : context.seats) {
            Player player = restored.state.getPlayer(seat.playerId);
            assertTrue(player.isHuman());
            assertEquals(seat.displayName, player.getName());
            assertEquals(123, seat.prioritySeconds);
            assertEquals(123, player.getPriorityTimeLeft());
            assertEquals(456, seat.matchPrioritySeconds);
            assertEquals(9, seat.bufferSeconds);
            assertEquals(9, player.getBufferTimeLeft());
            assertEquals(1, seat.deck.getSideboard().size());
            assertEquals(1, player.getHand().size());
            assertEquals("Island", restored.gameCards.get(player.getHand().iterator().next()).getName());
            assertEquals(Arrays.asList("Forest", "Island", "Mountain"), player.getLibrary().getCardList().stream()
                    .map(id -> restored.gameCards.get(id).getName()).collect(Collectors.toList()));
        }
        assertEquals(2, restored.state.getExile().getPermanentExile().size());
        assertEquals(1, restored.state.getContinuousEffects().getTotalEffectsCount());
        assertEquals(3, restored.state.getWatcher(SpellsCastWatcher.class).getNumberOfNonCreatureSpells());
        GameRandom reference = new GameRandom(77);
        for (int i = 0; i < 7; i++) reference.nextInt();
        assertEquals(reference.nextLong(), restored.state.getRandom().nextLong());
    }
}
