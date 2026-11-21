package org.mage.test.cards.abilities.keywords;

import mage.constants.PhaseStep;
import mage.constants.Zone;
import org.junit.Assert;
import org.junit.Test;
import org.mage.test.serverside.base.CardTestPlayerBase;

public class DayboundEntryReplacementTest extends CardTestPlayerBase {

    @Test
    public void dressDownSuppressesNightEntryUntilItLeaves() {
        currentGame.setDaytime(false);
        addCard(Zone.BATTLEFIELD, playerA, "Dress Down");
        addCard(Zone.BATTLEFIELD, playerA, "Swamp", 3);
        addCard(Zone.HAND, playerA, "Graveyard Trespasser");

        castSpell(1, PhaseStep.PRECOMBAT_MAIN, playerA, "Graveyard Trespasser");
        setStrictChooseMode(true);
        setStopAt(1, PhaseStep.POSTCOMBAT_MAIN);
        execute();

        assertPermanentCount(playerA, "Dress Down", 1);
        assertPowerToughness(playerA, "Graveyard Trespasser", 3, 3);

        setStopAt(1, PhaseStep.END_TURN);
        execute();

        assertGraveyardCount(playerA, "Dress Down", 1);
        assertPowerToughness(playerA, "Graveyard Glutton", 4, 4);
    }

    @Test
    public void reanimationUsesTheEnteringControllerForAbilityRemoval() {
        currentGame.setDaytime(false);
        addCard(Zone.BATTLEFIELD, playerA, "Plains", 8);
        addCard(Zone.BATTLEFIELD, playerA, "Swamp");
        addCard(Zone.HAND, playerA, "Overwhelming Splendor");
        addCard(Zone.HAND, playerA, "Reanimate");
        addCard(Zone.GRAVEYARD, playerB, "Tavern Ruffian");

        castSpell(1, PhaseStep.PRECOMBAT_MAIN, playerA, "Overwhelming Splendor", playerA);
        castSpell(3, PhaseStep.PRECOMBAT_MAIN, playerA, "Reanimate", "Tavern Ruffian");
        setStrictChooseMode(true);
        setStopAt(3, PhaseStep.END_TURN);
        execute();

        Assert.assertTrue(currentGame.checkDayNight(false));
        assertPowerToughness(playerA, "Tavern Ruffian", 1, 1);
        assertPermanentCount(playerA, "Tavern Smasher", 0);
    }
}
