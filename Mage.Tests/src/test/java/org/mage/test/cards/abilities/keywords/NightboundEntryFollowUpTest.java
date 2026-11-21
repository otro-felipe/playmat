package org.mage.test.cards.abilities.keywords;

import mage.abilities.keyword.HasteAbility;
import mage.constants.PhaseStep;
import mage.constants.Zone;
import org.junit.Test;
import org.mage.test.serverside.base.CardTestPlayerBase;

public class NightboundEntryFollowUpTest extends CardTestPlayerBase {

    @Test
    public void whipGrantsHasteAndExilesTheNightFace() {
        currentGame.setDaytime(false);
        addCard(Zone.BATTLEFIELD, playerA, "Whip of Erebos");
        addCard(Zone.BATTLEFIELD, playerA, "Swamp", 4);
        addCard(Zone.GRAVEYARD, playerA, "Tavern Ruffian");

        activateAbility(1, PhaseStep.PRECOMBAT_MAIN, playerA,
                "{2}{B}{B}, {T}: Return target creature", "Tavern Ruffian");
        checkAbility("returned creature has haste", 1, PhaseStep.BEGIN_COMBAT,
                playerA, "Tavern Smasher", HasteAbility.class, true);
        setStrictChooseMode(true);
        setStopAt(1, PhaseStep.END_TURN);
        execute();

        assertExileCount("Tavern Ruffian", 1);
        assertPermanentCount(playerA, "Tavern Smasher", 0);
    }

    @Test
    public void throughTheBreachGrantsHasteAndSacrificesTheNightFace() {
        currentGame.setDaytime(false);
        addCard(Zone.BATTLEFIELD, playerA, "Mountain", 5);
        addCard(Zone.HAND, playerA, "Through the Breach");
        addCard(Zone.HAND, playerA, "Brutal Cathar");

        castSpell(1, PhaseStep.PRECOMBAT_MAIN, playerA, "Through the Breach");
        setChoice(playerA, "Brutal Cathar");
        checkAbility("creature from hand has haste", 1, PhaseStep.BEGIN_COMBAT,
                playerA, "Moonrage Brute", HasteAbility.class, true);
        setStrictChooseMode(true);
        setStopAt(1, PhaseStep.END_TURN);
        execute();

        assertGraveyardCount(playerA, "Brutal Cathar", 1);
        assertPermanentCount(playerA, "Moonrage Brute", 0);
    }
}
