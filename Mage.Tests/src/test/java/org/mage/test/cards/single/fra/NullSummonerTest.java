package org.mage.test.cards.single.fra;

import mage.constants.PhaseStep;
import mage.constants.Zone;
import org.junit.Test;
import org.mage.test.serverside.base.CardTestPlayerBase;

public class NullSummonerTest extends CardTestPlayerBase {

    private static final String SUMMONER = "Null Summoner";
    private static final String SPELL = "Shock";

    @Test
    public void thresholdEnablesTheLinkedSpellAndAllowsOtherManaTypes() {
        addCard(Zone.GRAVEYARD, playerA, "Ornithopter", 6);
        addCard(Zone.EXILED, playerB, "Lightning Bolt");
        addCard(Zone.HAND, playerA, "Dark Ritual");
        castSummoner();
        checkPlayableAbility("six cards", 1, PhaseStep.POSTCOMBAT_MAIN, playerA, "Cast " + SPELL, false);

        castSpell(3, PhaseStep.PRECOMBAT_MAIN, playerA, "Dark Ritual");
        waitStackResolved(3, PhaseStep.PRECOMBAT_MAIN);
        checkPlayableAbility("seven cards", 3, PhaseStep.PRECOMBAT_MAIN, playerA, "Cast " + SPELL, true);
        checkPlayableAbility("unlinked exile", 3, PhaseStep.PRECOMBAT_MAIN, playerA, "Cast Lightning Bolt", false);
        castSpell(3, PhaseStep.PRECOMBAT_MAIN, playerA, SPELL, playerB);
        finish(3);

        assertLife(playerB, 18);
        assertGraveyardCount(playerB, SPELL, 1);
    }

    @Test
    public void thresholdEndsWhenTheGraveyardFallsBelowSeven() {
        addCard(Zone.GRAVEYARD, playerA, "Ornithopter", 7);
        addCard(Zone.BATTLEFIELD, playerB, "Tormod's Crypt");
        castSummoner();
        checkPlayableAbility("seven cards", 1, PhaseStep.POSTCOMBAT_MAIN, playerA, "Cast " + SPELL, true);
        activateAbility(2, PhaseStep.PRECOMBAT_MAIN, playerB, "{T}, Sacrifice", playerA);
        checkPlayableAbility("graveyard exiled", 3, PhaseStep.PRECOMBAT_MAIN, playerA, "Cast " + SPELL, false);
        finish(3);

        assertExileCount(playerB, SPELL, 1);
        assertPermanentCount(playerA, SUMMONER, 1);
    }

    @Test
    public void reenteringWithoutCastingDoesNotExileOrRestoreTheOldLink() {
        addCard(Zone.GRAVEYARD, playerA, "Ornithopter", 7);
        addCard(Zone.HAND, playerA, "Reanimate");
        addCard(Zone.BATTLEFIELD, playerB, "Swamp", 3);
        addCard(Zone.HAND, playerB, "Murder");
        addCard(Zone.HAND, playerB, "Negate");
        castSummoner();
        castSpell(2, PhaseStep.PRECOMBAT_MAIN, playerB, "Murder", SUMMONER);
        castSpell(3, PhaseStep.PRECOMBAT_MAIN, playerA, "Reanimate", SUMMONER);
        checkPlayableAbility("new battlefield object", 3, PhaseStep.POSTCOMBAT_MAIN, playerA, "Cast " + SPELL, false);
        finish(3);

        assertExileCount(playerB, SPELL, 1);
        assertPermanentCount(playerA, SUMMONER, 1);
        assertHandCount(playerB, "Negate", 1);
    }

    private void castSummoner() {
        addCard(Zone.BATTLEFIELD, playerA, "Island", 2);
        addCard(Zone.BATTLEFIELD, playerA, "Swamp", 4);
        addCard(Zone.HAND, playerA, SUMMONER);
        addCard(Zone.HAND, playerB, SPELL);
        addCard(Zone.HAND, playerB, "Mountain");
        castSpell(1, PhaseStep.PRECOMBAT_MAIN, playerA, SUMMONER);
        addTarget(playerA, playerB);
        setChoice(playerA, SPELL);
    }

    private void finish(int turn) {
        setStrictChooseMode(true);
        setStopAt(turn, PhaseStep.END_TURN);
        execute();
    }
}
