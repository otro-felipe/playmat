package org.mage.test.rollback;

import mage.cards.Card;
import mage.cards.CardsImpl;
import mage.constants.PhaseStep;
import mage.constants.Zone;
import mage.game.GameSnapshot;
import mage.game.GameState;
import mage.players.Player;
import mage.view.GameView;
import mage.server.websocket.rpc.JsonCodec;
import com.google.gson.JsonObject;
import org.junit.Test;
import org.mage.test.serverside.base.CardTestPlayerBase;

import java.util.Arrays;
import java.util.Collections;
import java.util.UUID;

import static org.junit.Assert.*;

public class RolledBackKnowledgeTest extends CardTestPlayerBase {

    @Test
    public void turnRestoreAndResumeUseOnlyTheCheckpointKnowledgeOfEachSeat() {
        addCard(Zone.HAND, playerA, "Forest");
        addCard(Zone.HAND, playerB, "Mountain");
        setStopAt(1, PhaseStep.PRECOMBAT_MAIN);
        execute();
        GameState state = currentGame.getState();
        Card forest = cardInHand(playerA, "Forest");
        Card mountain = cardInHand(playerB, "Mountain");
        playerA.revealCards("at checkpoint", new CardsImpl(forest), currentGame, false);
        state.getLookedAt(playerA.getId()).add("private A", forest);
        state.getLookedAt(playerB.getId()).add("private B", mountain);
        GameState checkpoint = state.copy();
        GameSnapshot saved = GameSnapshot.of(state, Collections.emptyMap(), Collections.emptyMap(), playerA.getId());

        // Add to the same window as well as a new one, then change zones and shuffle.
        state.getLookedAt(playerA.getId()).add("private A", mountain);
        state.getLookedAt(playerB.getId()).add("abandoned", forest);
        playerA.putCardsOnTopOfLibrary(forest, currentGame, null, false);
        playerA.shuffleLibrary(null, currentGame);
        state.clearRevealed();
        playerB.revealCards("abandoned", new CardsImpl(mountain), currentGame, false);
        assertEquals(Zone.LIBRARY, state.getZone(forest.getId()));

        for (GameState destination : new GameState[]{checkpoint, saved.restore().state}) {
            state.restoreForRollBack(destination);
            GameView a = GameView.forReplay(currentGame, playerA.getId(), null);
            GameView b = GameView.forReplay(currentGame, playerB.getId(), null);
            assertEquals(Zone.HAND, state.getZone(forest.getId()));
            for (GameView seat : new GameView[]{a, b}) {
                assertEquals(1, seat.getRevealed().size());
                assertEquals(Collections.singleton(forest.getId()), seat.getRevealed().get(0).getCards().keySet());
                assertEquals(Zone.HAND, seat.getRevealed().get(0).getCards().get(forest.getId()).getZone());
            }
            assertPrivateLook(a, forest.getId());
            assertPrivateLook(b, mountain.getId());
            assertTrue(GameView.forReplay(currentGame, null, null).getLookedAt().isEmpty());
            state.clearRevealed();
            state.clearLookedAt();
        }
        playerB.revealCards("abandoned", new CardsImpl(mountain), currentGame, false);
        assertEquals(Zone.HAND, state.getRevealed().getRevealedFrom(mountain.getId()));
    }

    @Test
    public void hiddenDepartureAndReplacementDrawInvalidateBothKnownCardsWithoutExposingWhichLeft() {
        addCard(Zone.HAND, playerB, "Forest");
        addCard(Zone.HAND, playerB, "Mountain");
        addCard(Zone.HAND, playerA, "Plains");
        setStopAt(1, PhaseStep.PRECOMBAT_MAIN);
        execute();
        GameState state = currentGame.getState();
        Card forest = cardInHand(playerB, "Forest");
        Card mountain = cardInHand(playerB, "Mountain");
        Card plains = cardInHand(playerA, "Plains");
        playerB.revealCards("public pair", new CardsImpl(Arrays.asList(forest, mountain)), currentGame, false);
        playerA.revealCards("other hand", new CardsImpl(plains), currentGame, false);
        state.clearRevealed(); // the prompt already closed before the turn was saved
        GameState checkpoint = state.copy();
        GameSnapshot saved = GameSnapshot.of(state, Collections.emptyMap(), Collections.emptyMap(), playerA.getId());
        assertTrue(knownTo(playerA.getId()).has(forest.getId().toString()));
        int count = playerB.getHand().size();
        playerB.putCardsOnTopOfLibrary(forest, currentGame, null, false);
        playerB.shuffleLibrary(null, currentGame);
        playerB.drawCards(1, null, currentGame);
        assertEquals(count, playerB.getHand().size());
        assertEquals(Collections.singleton(plains.getId().toString()), knownTo(playerA.getId()).keySet());
        for (GameState destination : new GameState[]{checkpoint, saved.restore().state}) {
            state.restoreForRollBack(destination);
            for (UUID seat : new UUID[]{playerA.getId(), playerB.getId()}) {
                JsonObject held = knownTo(seat);
                assertEquals(3, held.size());
                assertTrue(held.has(forest.getId().toString()));
                assertTrue(held.has(mountain.getId().toString()));
            }
            playerB.moveCards(forest, Zone.GRAVEYARD, null, currentGame);
            assertFalse(knownTo(playerA.getId()).has(forest.getId().toString()));
            assertTrue(knownTo(playerA.getId()).has(mountain.getId().toString()));
            playerB.moveCards(forest, Zone.HAND, null, currentGame);
            assertFalse(knownTo(playerA.getId()).has(forest.getId().toString()));
            playerB.revealCards("public pair", new CardsImpl(forest), currentGame, false);
            assertTrue(knownTo(playerA.getId()).has(forest.getId().toString()));
        }
        assertFalse(JsonCodec.GSON.toJsonTree(new GameView(state, currentGame, null, null)).getAsJsonObject().has("knownHandCards"));
        assertFalse(JsonCodec.GSON.toJsonTree(GameView.forReplay(currentGame, playerA.getId(), null)).getAsJsonObject().has("knownHandCards"));
    }

    @Test
    public void narsetRevealsOnlyTheChosenPhysicalCardAsItMovesDirectlyIntoHand() {
        skipInitShuffling();
        addCard(Zone.BATTLEFIELD, playerA, "Narset, Parter of Veils");
        addCard(Zone.LIBRARY, playerA, "Lightning Bolt", 4);
        activateAbility(1, PhaseStep.PRECOMBAT_MAIN, playerA, "-2:");
        setChoice(playerA, true);
        addTarget(playerA, "Lightning Bolt");
        setStrictChooseMode(true);
        setStopAt(1, PhaseStep.BEGIN_COMBAT);
        execute();
        assertHandCount(playerA, "Lightning Bolt", 1);
        UUID chosen = cardInHand(playerA, "Lightning Bolt").getId();
        assertEquals(Collections.singleton(chosen.toString()), knownTo(playerB.getId()).keySet());
        GameState checkpoint = currentGame.getState().copy();
        playerA.drawCards(1, null, currentGame);
        assertEquals(Collections.singleton(chosen.toString()), knownTo(playerB.getId()).keySet());
        currentGame.getState().restoreForRollBack(checkpoint);
        assertEquals(Collections.singleton(chosen.toString()), knownTo(playerB.getId()).keySet());
    }

    @Test
    public void impulsePicksPrivatelyWithoutPublishingTheChosenCard() {
        skipInitShuffling();
        addCard(Zone.BATTLEFIELD, playerA, "Island", 2);
        addCard(Zone.HAND, playerA, "Impulse");
        addCard(Zone.LIBRARY, playerA, "Lightning Bolt", 4);
        castSpell(1, PhaseStep.PRECOMBAT_MAIN, playerA, "Impulse");
        addTarget(playerA, "Lightning Bolt");
        setStopAt(1, PhaseStep.BEGIN_COMBAT);
        execute();
        assertHandCount(playerA, "Lightning Bolt", 1);
        assertEquals(0, knownTo(playerB.getId()).size());
    }

    private Card cardInHand(Player player, String name) {
        return player.getHand().getCards(currentGame).stream().filter(card -> card.getName().equals(name)).findFirst().get();
    }

    private JsonObject knownTo(UUID seat) {
        JsonObject view = JsonCodec.GSON.toJsonTree(new GameView(currentGame.getState(), currentGame, seat, null)).getAsJsonObject();
        assertTrue("Live seat carries authoritative public hand knowledge", view.has("knownHandCards"));
        return view.getAsJsonObject("knownHandCards");
    }

    private void assertPrivateLook(GameView seat, UUID card) {
        assertEquals(1, seat.getLookedAt().size());
        assertEquals(Collections.singleton(card), seat.getLookedAt().get(0).getCards().keySet());
    }
}
