package org.mage.test.cards.single.fra;

import mage.cards.Card;
import mage.cards.repository.CardRepository;
import mage.constants.PhaseStep;
import mage.constants.Zone;
import org.junit.Test;
import org.mage.test.serverside.base.CardTestPlayerBase;

import java.util.Collections;

import static org.junit.Assert.assertEquals;

public class ExtrapolateTheImpossibleTest extends CardTestPlayerBase {

    private static final String SPELL = "Extrapolate the Impossible";

    @Test
    public void opponentChoosesOneAndTheOtherStaysOutsideTheGame() {
        Card chosen = addSideboard("Negate");
        Card other = addSideboard("Duress");
        Card unused = addSideboard("Shock");
        setChoice(playerA, true);
        setChoice(playerA, "Negate");
        setChoice(playerA, "Duress");
        setChoice(playerB, "Negate");

        resolveSpell();

        assertHandCount(playerA, "Negate", 1);
        assertHandCount(playerA, "Duress", 0);
        assertHandCount(playerA, "Shock", 0);
        assertEquals(Zone.HAND, currentGame.getState().getZone(chosen.getId()));
        assertEquals(Zone.OUTSIDE, currentGame.getState().getZone(other.getId()));
        assertEquals(Zone.OUTSIDE, currentGame.getState().getZone(unused.getId()));
    }

    @Test
    public void casterCanDeclineToReveal() {
        addSideboard("Negate");
        addSideboard("Duress");
        setChoice(playerA, false);

        resolveSpell();

        assertHandCount(playerA, "Negate", 0);
        assertHandCount(playerA, "Duress", 0);
        assertEquals(2, playerA.getSideboard().size());
    }

    @Test
    public void copiesOfTheSameCardDoNotSupplyTwoDifferentNames() {
        addSideboard("Negate");
        addSideboard("Negate");
        addCard(Zone.EXILED, playerA, "Duress");

        resolveSpell();

        assertHandCount(playerA, "Negate", 0);
        assertHandCount(playerA, "Duress", 0);
        assertEquals(2, playerA.getSideboard().size());
    }

    private Card addSideboard(String name) {
        Card card = CardRepository.instance.findCard(name, true).createCard();
        currentGame.loadCards(Collections.singleton(card), playerA.getId());
        playerA.getSideboard().add(card);
        return card;
    }

    private void resolveSpell() {
        setStrictChooseMode(true);
        addCard(Zone.HAND, playerA, SPELL);
        addCard(Zone.BATTLEFIELD, playerA, "Swamp", 2);
        castSpell(1, PhaseStep.PRECOMBAT_MAIN, playerA, SPELL);
        setStopAt(1, PhaseStep.BEGIN_COMBAT);
        execute();
        assertGraveyardCount(playerA, SPELL, 1);
    }
}
