package mage.server.replay;

import mage.server.game.GameEventFeed;
import mage.server.websocket.rpc.JsonCodec;
import mage.abilities.effects.Effects;
import mage.game.Game;
import mage.target.TargetPlayer;
import mage.target.Targets;
import mage.view.CardView;
import mage.view.GameEventView;
import mage.view.GameView;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import org.junit.jupiter.api.Test;
import java.util.List;
import java.util.UUID;
import java.lang.reflect.Proxy;
import static mage.view.GameEventView.GameEventKind.*;
import static org.junit.jupiter.api.Assertions.*;

class ReplayBoardEventsTest {
    private static final class StackFixture extends CardView {
        StackFixture(Targets choices, Game game) { addTargets(choices, new Effects(), null, game); }
    }

    @Test void stackArrowsCanIncludeANonTargetSelectionWithoutConfirmingItAsATarget() {
        UUID chosen = UUID.randomUUID(), selection = UUID.randomUUID();
        Game game = (Game) Proxy.newProxyInstance(Game.class.getClassLoader(), new Class<?>[] {Game.class},
                (proxy, method, args) -> {
                    if (method.getName().equals("getCard")) return null;
                    throw new AssertionError(method.getName());
                });
        TargetPlayer target = new TargetPlayer(1);
        TargetPlayer nonTarget = new TargetPlayer(1, 1, true);
        target.add(chosen, game);
        nonTarget.add(selection, game);
        StackFixture view = new StackFixture(new Targets(target, nonTarget, new TargetPlayer(1)), game);
        JsonObject wire = JsonCodec.GSON.toJsonTree(view).getAsJsonObject();
        assertEquals(2, wire.getAsJsonArray("targets").size());
        assertEquals(1, wire.getAsJsonArray("chosenTargetIds").size());
        assertEquals(chosen.toString(), wire.getAsJsonArray("chosenTargetIds").get(0).getAsString());
    }

    @Test void archiveCarriesPublicDamageAndExileWithoutNamesPrivateIdentitiesOrRepeatedEvents() {
        UUID game = UUID.randomUUID(), source = UUID.randomUUID(), target = UUID.randomUUID();
        GameEventFeed feed = GameEventFeed.open(game);
        try {
            feed.add(new GameEventView(feed.nextSeq(), DAMAGE).source(source, "untrusted").target(target, "untrusted").amount(22), null);
            feed.add(new GameEventView(feed.nextSeq(), ZONE).target(target, "untrusted").zones("BATTLEFIELD","EXILED"), null);
            feed.add(new GameEventView(feed.nextSeq(), ZONE).target(target, "private").zones("BATTLEFIELD","EXILED"), source);
            feed.add(new GameEventView(feed.nextSeq(), DRAW).target(target, "private").zones("LIBRARY","HAND"), source);
            List<GameEventView> captured = ReplayBoardEvents.confirmed(feed.since(0, null));
            assertEquals(2, captured.size());
            assertEquals(22, captured.get(0).getAmount());
            assertEquals(source, captured.get(0).getSourceId());
            assertNull(captured.get(0).getTargetName());
            assertNull(captured.get(0).getSourceName());
            assertEquals(target, captured.get(1).getTargetId());
            GameView spectator = JsonCodec.GSON.fromJson("{\"players\":[]}", GameView.class);
            spectator.setEvents(captured);
            JsonArray serialized = ReplayEvidence.spectatorFrame(spectator).getAsJsonArray("events");
            assertEquals("DAMAGE", serialized.get(0).getAsJsonObject().get("kind").getAsString());
            assertEquals(22, serialized.get(0).getAsJsonObject().get("amount").getAsInt());
            assertEquals("ZONE", serialized.get(1).getAsJsonObject().get("kind").getAsString());
            assertEquals("EXILED", serialized.get(1).getAsJsonObject().get("toZone").getAsString());
            assertFalse(serialized.toString().contains("untrusted"));
            assertFalse(serialized.toString().contains("private"));
            assertTrue(ReplayBoardEvents.confirmed(feed.since(feed.lastSeq(), null)).isEmpty());
        } finally {
            GameEventFeed.close(game);
        }
    }
}
