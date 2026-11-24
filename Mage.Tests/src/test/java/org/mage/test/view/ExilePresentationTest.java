package org.mage.test.view;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import mage.cards.Card;
import mage.constants.PhaseStep;
import mage.constants.Zone;
import mage.server.websocket.rpc.JsonCodec;
import mage.view.GameView;
import org.junit.Test;
import org.mage.test.serverside.base.CardTestPlayerBase;

import java.util.UUID;

import static org.junit.Assert.*;

public class ExilePresentationTest extends CardTestPlayerBase {
    @Test
    public void linksExileCardsToTheirSpecificBattlefieldSources() {
        addCard(Zone.HAND, playerA, "Temporary Lockdown");
        addCard(Zone.HAND, playerA, "Portable Hole");
        addCard(Zone.BATTLEFIELD, playerA, "Plains", 4);
        addCard(Zone.BATTLEFIELD, playerB, "Grizzly Bears");
        addCard(Zone.BATTLEFIELD, playerB, "Savannah Lions");
        addCard(Zone.EXILED, playerB, "Forest");
        castSpell(1, PhaseStep.PRECOMBAT_MAIN, playerA, "Portable Hole");
        addTarget(playerA, "Savannah Lions");
        castSpell(1, PhaseStep.POSTCOMBAT_MAIN, playerA, "Temporary Lockdown");
        setStrictChooseMode(true);
        setStopAt(1, PhaseStep.END_TURN);
        execute();

        // Lockdown also exiles Portable Hole, so the Lions return and Portable Hole is now held by Lockdown.
        UUID lockdown = currentGame.getBattlefield().getAllPermanents().stream()
                .filter(card -> card.getName().equals("Temporary Lockdown")).findFirst().get().getId();
        for (GameView view : new GameView[]{liveView(), GameView.forReplay(currentGame, null, null)}) {
            JsonArray entries = presentation(view);
            assertEquals(2, entries.size());
            assertEquals(lockdown.toString(), entry(entries, exiled("Portable Hole")).get("sourceId").getAsString());
            assertEquals(lockdown.toString(), entry(entries, exiled("Grizzly Bears")).get("sourceId").getAsString());
            assertNull(entry(entries, exiled("Forest")));
        }
        assertPermanentCount(playerB, "Savannah Lions", 1);
    }

    @Test
    public void showsPermissionWithoutManaThenOmitsItAfterItExpires() {
        addCard(Zone.HAND, playerA, "Wrenn's Resolve");
        addCard(Zone.BATTLEFIELD, playerA, "Mountain", 2);
        skipInitShuffling();
        addCard(Zone.LIBRARY, playerA, "Lightning Bolt", 4);
        castSpell(1, PhaseStep.PRECOMBAT_MAIN, playerA, "Wrenn's Resolve");
        setStrictChooseMode(true);
        setStopAt(2, PhaseStep.PRECOMBAT_MAIN);
        execute();

        JsonArray entries = presentation(liveView());
        assertEquals(2, entries.size());
        for (JsonElement value : entries) {
            JsonArray players = value.getAsJsonObject().getAsJsonArray("playableBy");
            assertEquals(1, players.size());
            assertEquals(playerA.getId().toString(), players.get(0).getAsString());
        }
        currentGame.getState().setTurnNum(5);
        currentGame.getState().setActivePlayerId(playerA.getId());
        currentGame.getContinuousEffects().removeEndOfTurnEffects(currentGame);
        assertEquals(0, presentation(liveView()).size());
    }

    @Test
    public void permissionFollowsTheCasterRatherThanTheOwner() {
        addCard(Zone.BATTLEFIELD, playerA, "Stolen Strategy");
        addCard(Zone.LIBRARY, playerB, "Lightning Bolt", 4);
        skipInitShuffling();
        setStrictChooseMode(true);
        setStopAt(1, PhaseStep.PRECOMBAT_MAIN);
        execute();

        assertExileCount(playerB, "Lightning Bolt", 1);
        JsonObject permission = entry(presentation(liveView()), exiled("Lightning Bolt"));
        assertNotNull(permission);
        JsonArray players = permission.getAsJsonArray("playableBy");
        assertEquals(1, players.size());
        assertEquals(playerA.getId().toString(), players.get(0).getAsString());
    }

    private GameView liveView() {
        return new GameView(currentGame.getState(), currentGame, null, null);
    }

    private UUID exiled(String name) {
        return currentGame.getExile().getCardsOwned(currentGame, null).stream()
                .filter(card -> name.equals(card.getName())).findFirst().map(Card::getId).get();
    }

    private static JsonArray presentation(GameView view) {
        JsonArray result = JsonCodec.GSON.toJsonTree(view).getAsJsonObject().getAsJsonArray("exilePresentation");
        return result == null ? new JsonArray() : result;
    }

    private static JsonObject entry(JsonArray entries, UUID id) {
        for (JsonElement value : entries) {
            JsonObject entry = value.getAsJsonObject();
            if (id.toString().equals(entry.get("cardId").getAsString())) return entry;
        }
        return null;
    }
}
