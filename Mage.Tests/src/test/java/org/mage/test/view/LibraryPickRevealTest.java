package org.mage.test.view;

import mage.constants.PhaseStep;
import mage.constants.Zone;
import mage.game.events.TableEvent;
import mage.view.CardView;
import mage.view.GameView;
import org.junit.Test;
import org.mage.test.serverside.base.CardTestPlayerBase;

import java.util.ArrayList;
import java.util.List;
import java.util.stream.Collectors;

import static org.junit.Assert.*;

public class LibraryPickRevealTest extends CardTestPlayerBase {
    private static final String NARSET = "Narset, Parter of Veils";

    private final List<GameView> opponentUpdates = new ArrayList<>();
    private final List<GameView> ownerUpdates = new ArrayList<>();
    private final List<String> revealLog = new ArrayList<>();

    private void captureSeatViews() {
        runCode("capture the views broadcast by XMage", 1, PhaseStep.PRECOMBAT_MAIN, playerA, (info, player, game) -> {
            game.addTableEventListener(event -> {
                if (event.getEventType() == TableEvent.EventType.INFO && event.getMessage().contains(" reveals ")) {
                    revealLog.add(event.getMessage());
                }
                if (event.getEventType() == TableEvent.EventType.UPDATE) {
                    opponentUpdates.add(new GameView(game.getState(), game, playerB.getId(), null));
                    ownerUpdates.add(new GameView(game.getState(), game, playerA.getId(), null));
                }
            });
        });
    }

    private void narset(boolean pick) {
        skipInitShuffling();
        setStrictChooseMode(true);
        addCard(Zone.BATTLEFIELD, playerA, NARSET);
        addCard(Zone.LIBRARY, playerA, "Mountain", 3);
        addCard(Zone.LIBRARY, playerA, "Opt");
        captureSeatViews();
        activateAbility(1, PhaseStep.PRECOMBAT_MAIN, playerA, "-2: ");
        setChoice(playerA, pick);
        if (pick) {
            addTarget(playerA, "Opt");
        }
        setStopAt(1, PhaseStep.BEGIN_COMBAT);
        execute();
    }

    private void opponentSeesOnly(String source, int looked, String chosen) {
        assertTrue("the private look reaches the owner", ownerUpdates.stream()
                .anyMatch(view -> view.getLookedAt().stream().anyMatch(group -> group.getName().contains(source) && group.getCards().size() == looked)));
        assertTrue("the other seat never sees the private look", opponentUpdates.stream().allMatch(view -> view.getLookedAt().isEmpty()));
        List<CardView> publicCards = opponentUpdates.stream().flatMap(view -> view.getRevealed().stream())
                .filter(group -> group.getName().contains(source))
                .flatMap(group -> group.getCards().values().stream()).collect(Collectors.toList());
        List<String> sourceLog = revealLog.stream().filter(line -> line.contains(source)).collect(Collectors.toList());
        if (chosen == null) {
            assertTrue("declining leaves no public reveal in the log", sourceLog.isEmpty());
            assertTrue("declining reveals no card", publicCards.isEmpty());
        } else {
            assertFalse("the opponent receives the chosen card", publicCards.isEmpty());
            assertTrue(publicCards.stream().allMatch(card -> chosen.equals(card.getName()) && card.getZone() == Zone.LIBRARY));
            assertEquals("one permanent log entry for the public reveal", 1, sourceLog.size());
            assertTrue(sourceLog.get(0).contains(chosen));
            assertFalse(sourceLog.get(0).contains("Mountain"));
            assertHandCount(playerA, chosen, 1);
        }
    }

    @Test
    public void narsetShowsOpponentOnlyTheSelectedCard() {
        narset(true);
        opponentSeesOnly(NARSET, 4, "Opt");
    }

    @Test
    public void decliningNarsetRevealsNothing() {
        narset(false);
        opponentSeesOnly(NARSET, 4, null);
        assertHandCount(playerA, "Opt", 0);
    }

    @Test
    public void boardTheWeatherlightAlsoRevealsOnlyTheChosenHistoricCard() {
        skipInitShuffling();
        setStrictChooseMode(true);
        addCard(Zone.BATTLEFIELD, playerA, "Plains", 2);
        addCard(Zone.HAND, playerA, "Board the Weatherlight");
        addCard(Zone.LIBRARY, playerA, "Mountain", 4);
        addCard(Zone.LIBRARY, playerA, "Sol Ring");
        captureSeatViews();
        castSpell(1, PhaseStep.PRECOMBAT_MAIN, playerA, "Board the Weatherlight");
        setChoice(playerA, true);
        addTarget(playerA, "Sol Ring");
        setStopAt(1, PhaseStep.BEGIN_COMBAT);
        execute();
        opponentSeesOnly("Board the Weatherlight", 5, "Sol Ring");
    }
}
