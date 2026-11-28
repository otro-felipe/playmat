package mage.server.recovery;

import mage.cards.Card;
import mage.game.*;
import mage.game.match.Match;
import mage.game.match.MatchOptions;
import mage.game.match.MatchPlayer;
import mage.interfaces.MageServer;
import mage.players.PlayerType;
import mage.server.TableController;
import mage.server.User;
import mage.server.managers.ManagerFactory;
import mage.server.playtesting.ProductGateway;
import mage.server.websocket.rpc.RpcException;
import org.apache.log4j.Logger;

import java.io.IOException;
import java.nio.file.Paths;
import java.sql.SQLException;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;

/** Single-engine recovery service. SQLite's durable claim plus its process lock fence every restored table. */
public final class PvpRecovery {
    private static final Logger log = Logger.getLogger(PvpRecovery.class);
    private static final boolean ENABLED = "on".equals(System.getenv("PLAYMAT_PVP_RECOVERY")) && ProductGateway.enabled();
    private static PvpRecovery instance;
    private final String boot = UUID.randomUUID().toString();
    private final CheckpointStore store;
    private final String engine;
    private final Map<UUID, Live> tables = new ConcurrentHashMap<>();
    private final Map<UUID, Map<RecoveryPrincipal, UUID>> waiting = new HashMap<>();

    private static final class Live {
        UUID originalTable;
        CheckpointContext restored;
        GameSnapshot snapshot;
        final Map<UUID, RecoveryPrincipal> players = new HashMap<>();
        UUID chooser;
        boolean ready;
    }

    public static boolean enabled() { return ENABLED; }
    private PvpRecovery() throws IOException, SQLException {
        GameSnapshot.setLoader(mage.server.util.PluginUtil.classLoader);
        engine = PvpCheckpoints.fingerprint(Paths.get("."));
        store = new CheckpointStore(Paths.get("db", "pvp-recovery.db"));
        store.boot(boot);
    }
    private static synchronized PvpRecovery get() throws IOException, SQLException {
        if (!ENABLED) throw new IllegalStateException("PvP recovery is disabled on this server");
        if (instance == null) instance = new PvpRecovery();
        return instance;
    }

    private static Map<UUID, RecoveryPrincipal> principals(TableController controller, ManagerFactory managers) {
        Map<UUID, RecoveryPrincipal> result = new HashMap<>();
        controller.getUserPlayerMap().forEach((userId, playerId) -> managers.userManager().getUser(userId)
                .map(User::getRecoveryPrincipal).ifPresent(p -> result.put(playerId, p)));
        return result;
    }
    private static boolean eligible(TableController controller, ManagerFactory managers) {
        return ENABLED && !controller.getTable().isTournament() && !controller.getTable().isTournamentSubTable()
                && !controller.getOptions().isRated() && !controller.getOptions().isSpectatorsAllowed()
                && controller.getMatch().getPlayers().size() == 2 && controller.getUserPlayerMap().size() == 2
                && controller.getMatch().getPlayers().stream().allMatch(p -> p.getPlayer().isHuman())
                && principals(controller, managers).size() == 2;
    }

    public static void beforeGame(TableController controller, ManagerFactory managers) {
        if (eligible(controller, managers) && controller.getOptions().getSeed() == null) {
            controller.getOptions().setSeed(new java.security.SecureRandom().nextLong());
        }
    }

    public static void prepareGame(TableController controller, GameOptions options, UUID chooser, ManagerFactory managers) {
        if (!eligible(controller, managers)) return;
        try {
            PvpRecovery service = get();
            Live live = service.tables.get(controller.getTable().getId());
            if (live == null) {
                live = new Live();
                live.originalTable = controller.getTable().getId();
                live.players.putAll(principals(controller, managers));
                if (new HashSet<>(live.players.values()).size() != 2
                        || live.players.values().stream().anyMatch(p -> !ProductGateway.recoveryPrincipalValid(p))) {
                    throw new IllegalStateException("Both admitted participants require current durable principals");
                }
            }
            Live entry = live;
            Match match = controller.getMatch();
            if (entry.restored != null && "turn".equals(entry.restored.phase)) {
                Map<UUID, UUID> ids = new HashMap<>();
                for (CheckpointContext.Seat seat : entry.restored.seats) {
                    UUID current = entry.players.entrySet().stream().filter(e -> seat.principal.equals(e.getValue()))
                            .map(Map.Entry::getKey).findFirst().orElseThrow(() -> new IllegalStateException("Reserved participant missing"));
                    ids.put(seat.playerId, current);
                }
                options.resumeFrom = entry.snapshot.withPlayers(ids);
                options.resumeFrom.restore(); // Fail before creating any game session, not inside an already published game.
                options.seed = null;
            }
            entry.chooser = chooser == null ? entry.chooser : chooser;
            final Game game = match.getGame();
            options.durableRecoveryBarrier = true;
            if (entry.restored != null) service.store.liveGame(match.getId(),controller.getTable().getId(),game.getId(),service.boot);
            options.turnSnapshots = snapshot -> {
                try {
                    service.save(controller, entry, snapshot, "turn", entry.chooser, null);
                } catch (Exception e) {
                    log.warn("Recovery checkpoint failed for match=" + match.getId() + "; last confirmed boundary is unchanged");
                }
            };
            // A resumed turn must not be replaced by a freshly dealt pregame state before the snapshot is applied.
            if (options.resumeFrom == null) {
                Map<UUID, Card> cards = new LinkedHashMap<>();
                for (MatchPlayer p : match.getPlayers()) {
                    p.getDeck().getCards().forEach(c -> cards.put(c.getId(), c));
                    p.getDeck().getSideboard().forEach(c -> cards.put(c.getId(), c));
                }
                service.save(controller, entry, GameSnapshot.of(game.getState(), cards, Collections.emptyMap(), null),
                        "pregame", entry.chooser, game.getState());
            }
            entry.restored = null;
            service.tables.put(controller.getTable().getId(), entry);
        } catch (Exception e) {
            // An opted-in match must not silently start with a partially applied restore or unbound participants.
            throw new IllegalStateException("The private match checkpoint could not be prepared; the game was not started", e);
        }
    }

    private void save(TableController controller, Live live, GameSnapshot snapshot, String phase, UUID chooser,
                      GameState state) throws IOException, SQLException {
        CheckpointContext context = controller.getMatch().getGame() == null
                ? new CheckpointContext(live.originalTable,controller.getMatch(),controller.getUserPlayerMap(),state,
                    live.restored.gameId,live.restored.gameNumber)
                : state == null
                ? new CheckpointContext(live.originalTable, controller.getMatch(), controller.getUserPlayerMap(), snapshot)
                : new CheckpointContext(live.originalTable, controller.getMatch(), controller.getUserPlayerMap(), state);
        context.phase = phase; context.chooser = chooser;
        for (CheckpointContext.Seat seat : context.seats) seat.principal = live.players.get(seat.playerId);
        store.saveRecoverable(context, snapshot.toBytes(), engine, boot, controller.getTable().getId(), context.gameId);
        live.snapshot = snapshot;
    }

    public static void gameEnded(TableController controller, Game game, UUID chooser, ManagerFactory managers) {
        if (!ENABLED || instance == null) return;
        Live live = instance.tables.get(controller.getTable().getId());
        if (live == null) return;
        try {
            if (controller.getMatch().hasEnded()) {
                instance.store.gameEnded(controller.getMatch().getId(), game.getId(), true);
                instance.store.finish(controller.getMatch().getId(), "completed");
            } else {
                live.chooser = chooser;
                instance.save(controller, live, live.snapshot, "sideboard", chooser, game.getState());
            }
        } catch (Exception e) { throw new IllegalStateException("The match boundary could not be confirmed durably", e); }
    }

    public static void sideboardChanged(TableController controller) {
        if (!ENABLED || instance == null) return;
        Live live = instance.tables.get(controller.getTable().getId());
        if (live == null) return;
        try {
            // Match decks are authoritative during sideboarding; the ended game's frozen players supply clocks/IDs.
            GameState state = controller.getMatch().getGame() == null ? live.snapshot.restore().state : controller.getMatch().getGame().getState();
            instance.save(controller, live, live.snapshot, "sideboard", live.chooser, state);
        } catch (Exception e) { throw new IllegalStateException("The sideboard change could not be confirmed durably", e); }
    }

    public static void failed(TableController controller) {
        if (!ENABLED || instance == null || !instance.tables.containsKey(controller.getTable().getId())) return;
        try { instance.store.finish(controller.getMatch().getId(), "failed"); }
        catch (SQLException e) { log.warn("Recovery failure status could not be persisted for match="+controller.getMatch().getId()); }
        instance.tables.remove(controller.getTable().getId());
    }

    public static void stopTable(UUID table) throws IOException, SQLException {
        if (!ENABLED) return;
        PvpRecovery service = get();
        synchronized (service) {
            for (UUID match : service.store.stopTable(table)) service.waiting.remove(match);
            service.tables.remove(table);
        }
    }

    public static boolean reserved(UUID table) { return instance != null && instance.tables.containsKey(table) && instance.tables.get(table).restored != null; }
    public static boolean mayJoin(UUID table, RecoveryPrincipal principal, PlayerType type) {
        Live live = instance == null ? null : instance.tables.get(table);
        return live != null && type == PlayerType.HUMAN && live.restored != null
                && live.restored.seats.stream().anyMatch(s -> s.principal.equals(principal));
    }
    public static boolean mayStart(UUID table) { return !reserved(table) || instance.tables.get(table).ready; }
    public static UUID chooser(UUID table, UUID fallback) {
        Live live = instance == null ? null : instance.tables.get(table);
        return live == null || live.chooser == null ? fallback : live.chooser;
    }

    public static final class RecoveryView {
        public String matchId, originalTableId, originalGameId, tableId, gameId, status, phase, message, link;
        public long revision, generation;
        public int turn, gameNumber;
        public boolean agreed;
    }

    private static RecoveryPrincipal require(User user) throws RpcException {
        if (!ENABLED) throw RpcException.invalidParams("Private PvP recovery is disabled on this server");
        RecoveryPrincipal principal = user == null ? null : user.getRecoveryPrincipal();
        if (!ProductGateway.recoveryPrincipalValid(principal)) throw RpcException.notAuthorized("This recovery seat is no longer authorized");
        return principal;
    }
    private synchronized RecoveryView view(UUID id, RecoveryPrincipal principal) throws Exception {
        if (!store.participant(id, principal)) throw RpcException.notAuthorized("Match recovery is unavailable to this seat");
        CheckpointStore.Captured captured;
        try { captured = store.inspect(id, engine); }
        catch (IllegalStateException incompatible) {
            RecoveryView unavailable = new RecoveryView();
            unavailable.matchId=id.toString(); unavailable.originalTableId=store.originalTable(id);
            unavailable.link="/recover/"+id; unavailable.status="unavailable";
            unavailable.message="The durable checkpoint is incompatible with this engine build or failed its integrity check. No table was loaded. Keep the private checkpoint and use its matching engine image.";
            return unavailable;
        }
        if (captured == null) throw new IllegalStateException("No durable checkpoint exists for this match");
        CheckpointContext context = (CheckpointContext) CheckpointContext.read(captured.context);
        CheckpointStore.Claim claim = store.claim(id);
        RecoveryView view = new RecoveryView(); view.matchId=id.toString(); view.originalTableId=context.tableId.toString();
        view.originalGameId=store.originalGame(id,context.gameNumber);
        view.revision=captured.revision; view.generation=claim.generation; view.phase=context.phase;
        view.turn="turn".equals(context.phase) ? captured.turn : 0; view.gameNumber=context.gameNumber;
        view.status="completed".equals(captured.status) ? "completed" : claim.status;
        view.link="/recover/"+id;
        if ("cancelled".equals(view.status)) {
            view.message = "The tournament organizer stopped this match.";
            return view;
        }
        if ("live".equals(view.status) && boot.equals(claim.bootId)) {
            view.tableId=claim.tableId; view.gameId="sideboard".equals(context.phase) ? null : claim.gameId;
        }
        view.message="turn".equals(context.phase)
                ? "Resume from the start of the last durably confirmed turn " + captured.turn + ". Later decisions and time consumption are discarded. Both participants must agree."
                : "sideboard".equals(context.phase)
                ? "Resume the durably saved score and sideboard lists. Both players must confirm their sideboards again. Downtime does not consume clocks."
                : "No turn was confirmed yet in this game. Restart its opening choices and mulligans with the saved decks and score. Both participants must agree.";
        return view;
    }

    public static List<RecoveryView> list(User user) throws RpcException {
        RecoveryPrincipal principal=require(user);
        try {
            PvpRecovery service=get(); List<RecoveryView> result=new ArrayList<>();
            for (UUID id : service.store.matches(principal)) result.add(service.view(id,principal));
            return result;
        } catch (RpcException e) { throw e; }
        catch (Exception e) { throw new RpcException(RpcException.SERVER_ERROR,"Recovery checkpoints are unavailable or incompatible"); }
    }
    public static RecoveryView status(UUID id, User user) throws RpcException {
        RecoveryPrincipal principal=require(user);
        try { return get().view(id,principal); }
        catch (RpcException e) { throw e; }
        catch (Exception e) { throw new RpcException(RpcException.SERVER_ERROR,"Recovery checkpoint is unavailable or incompatible with this engine"); }
    }

    public static RecoveryView join(ManagerFactory managers, MageServer server, String sessionId, User user,
                            UUID id, long revision, boolean agree) throws RpcException {
        RecoveryPrincipal principal=require(user);
        try { return get().joinLocked(managers,server,sessionId,user,principal,id,revision,agree); }
        catch (RpcException e) { throw e; }
        catch (Exception e) {
            // Class/line diagnostics are useful without logging serialized state, credentials or exception values.
            for (Throwable cause=e; cause!=null; cause=cause.getCause()) {
                StackTraceElement[] stack=cause.getStackTrace();
                log.warn("Recovery join failed: match="+id+" type="+cause.getClass().getName()
                        +" location="+(stack.length==0?"unknown":stack[0]));
            }
            throw new RpcException(RpcException.SERVER_ERROR,"Recovery could not be completed; no new game is ready. Check the match status.");
        }
    }

    private synchronized RecoveryView joinLocked(ManagerFactory managers, MageServer server, String sessionId, User user,
                                         RecoveryPrincipal principal, UUID id, long revision, boolean agree) throws Exception {
        RecoveryView current=view(id,principal);
        if ("live".equals(current.status)) {
            TableController controller=managers.tableManager().getController(UUID.fromString(current.tableId)).orElse(null);
            if (controller==null || !controller.hasPlayer(user.getId())) throw new IllegalStateException("Live recovery owner is missing");
            if (current.gameId!=null) {
                UUID player=controller.getUserPlayerMap().get(user.getId());
                user.ccGameStarted(controller.getTable().getId(),controller.getTable().getParentTableId(),UUID.fromString(current.gameId),player);
            }
            return current;
        }
        if (!"waiting".equals(current.status)) return current;
        if (revision!=current.revision) throw RpcException.invalidParams("Read the current confirmed checkpoint before agreeing");
        if (!agree) return current;
        store.consent(id,principal,revision);
        Map<RecoveryPrincipal,UUID> present=waiting.computeIfAbsent(id,k -> new HashMap<>());
        present.put(principal,user.getId());
        present.entrySet().removeIf(e -> !managers.userManager().getUser(e.getValue())
                .filter(u -> u.isConnected() && e.getKey().equals(u.getRecoveryPrincipal())).isPresent());
        if (present.size()!=2) { current.agreed=true; return current; }
        CheckpointStore.Captured row=store.inspect(id,engine);
        CheckpointContext saved=(CheckpointContext)CheckpointContext.read(row.context);
        if (saved.seats.size()!=2 || saved.seats.stream().anyMatch(s -> !present.containsKey(s.principal)
                || !managers.userManager().getUser(present.get(s.principal)).map(User::getRecoveryPrincipal)
                    .map(ProductGateway::recoveryPrincipalValid).orElse(false))) throw RpcException.notAuthorized("A reserved participant is unavailable");
        GameSnapshot snapshot=GameSnapshot.fromBytes(row.snapshot);
        snapshot.restore();
        String claim=store.acquire(id,revision,boot);
        if (claim==null) return view(id,principal);
        UUID room=managers.gamesRoomManager().getMainRoomId();
        UUID tableId=null;
        try {
            MatchOptions options=saved.options;
            options.setPassword(UUID.randomUUID().toString()); options.setSpectatorsAllowed(false); options.setRated(false);
            mage.game.match.ChampionshipRules restoredChampionship = options.championship;
            tableId=server.roomCreateTable(sessionId,room,options).getTableId();
            if (!ProductGateway.restoreHumanSeat(saved.tableId, tableId)) {
                throw new IllegalStateException("Could not restore the original human seat policy");
            }
            Live live=new Live(); live.originalTable=saved.tableId; live.restored=saved; live.snapshot=snapshot;
            tables.put(tableId,live);
            TableController controller=managers.tableManager().getController(tableId).orElseThrow(IllegalStateException::new);
            controller.getOptions().championship = restoredChampionship;
            for (CheckpointContext.Seat seat:saved.seats) {
                User admitted=managers.userManager().getUser(present.get(seat.principal)).orElseThrow(IllegalStateException::new);
                if (!admitted.isConnected() || !seat.principal.equals(admitted.getRecoveryPrincipal())
                        || !server.roomJoinTable(admitted.getSessionId(),room,tableId,admitted.getName(),PlayerType.HUMAN,1,seat.deck,options.getPassword())) {
                    throw new IllegalStateException("Reserved seat could not be attached");
                }
                UUID newPlayer=controller.getUserPlayerMap().get(admitted.getId());
                live.players.put(newPlayer,seat.principal);
                MatchPlayer mp=controller.getMatch().getPlayer(newPlayer);
                for(int win=0;win<seat.wins;win++) mp.addWin();
                mp.setPriorityTimeLeft(seat.matchPrioritySeconds);
                if (seat.playerId.equals(saved.chooser)) live.chooser=newPlayer;
            }
            Map<UUID,UUID> remap=new HashMap<>();
            for(CheckpointContext.Seat seat:saved.seats) live.players.forEach((player,p) -> {if(p.equals(seat.principal)) remap.put(seat.playerId,player);});
            boolean sideboard="sideboard".equals(saved.phase);
            controller.getMatch().restoreProgress(id,sideboard ? saved.gameNumber : saved.gameNumber-1,saved.draws);
            // Activate only after both authenticated seats, decks and full snapshot have validated.
            store.activate(id,claim,tableId,saved.gameId);
            live.ready=true;
            if (sideboard) {
                live.snapshot=snapshot.withPlayers(remap);
                save(controller,live,live.snapshot,"sideboard",live.chooser,live.snapshot.restore().state);
                controller.resumeSideboarding(live.chooser);
            }
            else {
                if (!controller.changeTableStateToStarting()) throw new IllegalStateException("Restored table is not ready");
                controller.startMatch(user.getId());
                if (!managers.tableManager().getController(tableId).isPresent() || controller.getMatch().getGame()==null) {
                    throw new IllegalStateException("Restored match did not start");
                }
            }
            waiting.remove(id);
            return view(id,principal);
        } catch(Exception e) {
            store.finish(id,"failed");
            if(tableId!=null) { tables.remove(tableId); managers.tableManager().removeTableByStaff(tableId); }
            throw e;
        }
    }
}
