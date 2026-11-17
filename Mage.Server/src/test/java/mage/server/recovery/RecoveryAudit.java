package mage.server.recovery;

import com.google.gson.Gson;
import mage.game.GameSnapshot;
import mage.players.Player;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.security.MessageDigest;
import java.sql.*;
import java.util.*;
import java.util.stream.Collectors;

/** Private local acceptance helper. No network endpoint; outputs only hashes/counts from fixture checkpoints. */
public final class RecoveryAudit {
    private static String hash(String value) throws Exception {
        StringBuilder hex=new StringBuilder();
        for(byte b:MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8))) hex.append(String.format("%02x",b&255));
        return hex.toString();
    }
    public static void main(String[] args) throws Exception {
        if (!"yes".equals(System.getenv("PLAYMAT_RECOVERY_LOCAL_TEST"))) throw new IllegalStateException("Fixture audit requires local test opt-in");
        try(Connection db=DriverManager.getConnection("jdbc:sqlite:"+args[0]);
            PreparedStatement s=db.prepareStatement("SELECT context,snapshot,revision FROM checkpoints WHERE match_id=?")) {
            s.setString(1,args[1]);
            try(ResultSet r=s.executeQuery()) {
                if(!r.next()) throw new IllegalStateException("No fixture checkpoint");
                CheckpointContext context=(CheckpointContext)CheckpointContext.read(r.getBytes(1));
                GameSnapshot.Restored restored=GameSnapshot.fromBytes(r.getBytes(2)).restore();
                Map<String,Object> result=new TreeMap<>();
                result.put("phase",context.phase); result.put("turn",context.turn);result.put("gameNumber",context.gameNumber);result.put("draws",context.draws);
                Map<String,Object> seats=new TreeMap<>();
                for(CheckpointContext.Seat seat:context.seats) {
                    Player player=restored.state.getPlayer(seat.playerId);
                    Map<String,Object> value=new TreeMap<>();
                    value.put("library",hash(player.getLibrary().getCardList().toString()));
                    value.put("hand",hash(player.getHand().stream().map(UUID::toString).sorted().collect(Collectors.joining(","))));
                    value.put("libraryCount",player.getLibrary().size());value.put("handCount",player.getHand().size());
                    value.put("life",player.getLife());value.put("wins",seat.wins);
                    value.put("priority",seat.prioritySeconds);value.put("buffer",seat.bufferSeconds);value.put("matchPriority",seat.matchPrioritySeconds);
                    value.put("sideboard",hash(new Gson().toJson(seat.deck.getSideboard())));
                    seats.put(seat.principal.seatId,value);
                }
                result.put("seats",seats);
                result.put("exile",hash(restored.state.getExile().getExileZones().stream().flatMap(z->z.stream()).map(UUID::toString).sorted().collect(Collectors.joining(","))));
                result.put("exiledCards",restored.state.getExile().getExileZones().stream().mapToInt(Set::size).sum());
                result.put("effects",restored.state.getContinuousEffects().getTotalEffectsCount());
                List<Long> random=new ArrayList<>();
                if(restored.state.getRandom()!=null) for(int i=0;i<10;i++) random.add(restored.state.getRandom().nextLong());
                result.put("rng",hash(random.toString()));
                Files.write(Paths.get(args[2]),new Gson().toJson(result).getBytes(StandardCharsets.UTF_8));
                System.out.println("Private fixture audit recorded: phase="+context.phase+" turn="+context.turn+" effects="+result.get("effects")+" exiled="+result.get("exiledCards"));
            }
        }
    }
}
