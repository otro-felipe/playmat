package org.mage.test.playmat;

import mage.constants.PhaseStep;
import mage.constants.Zone;
import org.junit.Test;
import org.mage.test.serverside.base.CardTestPlayerBase;

import static org.junit.Assert.assertEquals;

/** Exact synthetic engine witnesses for PM-THEORY-5. */
public class TheorycraftSheoldredTest extends CardTestPlayerBase {
    private static final String SHEOLDRED = "Sheoldred, the Apocalypse";
    private static final String BURST = "Burst Lightning";
    private static final String DEN = "Den of the Bugbear";

    @Test
    public void plainThenKickedBurstKillWithSixRedSources() {
        preparePosition(6);

        setChoice(playerA, false);
        castSpell(1, PhaseStep.PRECOMBAT_MAIN, playerA, BURST, SHEOLDRED, true);
        checkSheoldredDamage(1, PhaseStep.PRECOMBAT_MAIN, 2);
        setChoice(playerA, true);
        castSpell(1, PhaseStep.PRECOMBAT_MAIN, playerA, BURST, SHEOLDRED, true);
        checkPermanentTapped("all six sources spent", 1, PhaseStep.PRECOMBAT_MAIN, playerA, "Mountain", true, 6);

        finishFirstMain();
        assertGraveyardCount(playerB, SHEOLDRED, 1);
        assertGraveyardCount(playerA, BURST, 2);
        assertHandCount(playerA, BURST, 0);
    }

    @Test
    public void kickedBurstSpendsAllFiveRedSourcesAndLeavesSheoldredAlive() {
        preparePosition(5);

        setChoice(playerA, true);
        castSpell(1, PhaseStep.PRECOMBAT_MAIN, playerA, BURST, SHEOLDRED, true);
        checkSheoldredDamage(1, PhaseStep.PRECOMBAT_MAIN, 4);
        checkPermanentTapped("all five sources spent", 1, PhaseStep.PRECOMBAT_MAIN, playerA, "Mountain", true, 5);

        finishFirstMain();
        assertPermanentCount(playerB, SHEOLDRED, 1);
        assertGraveyardCount(playerA, BURST, 1);
        assertHandCount(playerA, BURST, 1);
    }

    @Test
    public void twoPlainBurstsWithFiveRedSourcesLeaveSheoldredAlive() {
        preparePosition(5);

        setChoice(playerA, false);
        castSpell(1, PhaseStep.PRECOMBAT_MAIN, playerA, BURST, SHEOLDRED, true);
        setChoice(playerA, false);
        castSpell(1, PhaseStep.PRECOMBAT_MAIN, playerA, BURST, SHEOLDRED, true);
        checkSheoldredDamage(1, PhaseStep.PRECOMBAT_MAIN, 4);

        finishFirstMain();
        assertPermanentCount(playerB, SHEOLDRED, 1);
        assertGraveyardCount(playerA, BURST, 2);
    }

    @Test
    public void animatedDenBlocksAndFundsTheKillingBurst() {
        preparePosition(4);
        addCard(Zone.BATTLEFIELD, playerA, DEN + "@den");

        for (int i = 1; i <= 4; i++) {
            activateManaAbility(2, PhaseStep.BEGIN_COMBAT, playerA, "@fuel." + i + " {T}: Add {R}");
        }
        activateAbility(2, PhaseStep.BEGIN_COMBAT, playerA, "{3}{R}: Until end of turn");
        waitStackResolved(2, PhaseStep.BEGIN_COMBAT, playerA);
        checkPT("Den becomes a 3/2", 2, PhaseStep.BEGIN_COMBAT, playerA, DEN, 3, 2);
        checkPermanentTapped("Den saved for the block", 2, PhaseStep.BEGIN_COMBAT, playerA, DEN, false, 1);
        attack(2, playerB, SHEOLDRED);
        block(2, playerA, DEN, SHEOLDRED);
        checkBlockers("Den declared before tapping", 2, playerA, DEN);
        activateManaAbility(2, PhaseStep.DECLARE_BLOCKERS, playerA, "@den {T}: Add {R}");
        setChoice(playerA, false);
        castSpell(2, PhaseStep.DECLARE_BLOCKERS, playerA, BURST, SHEOLDRED, true);
        checkPermanentTapped("Den supplies mana after blocking", 2, PhaseStep.DECLARE_BLOCKERS, playerA, DEN, true, 1);
        checkSheoldredDamage(2, PhaseStep.DECLARE_BLOCKERS, 2);

        setStopAt(2, PhaseStep.END_COMBAT);
        execute();
        assertGraveyardCount(playerA, DEN, 1);
        assertGraveyardCount(playerB, SHEOLDRED, 1);
        assertGraveyardCount(playerA, BURST, 1);
        assertHandCount(playerA, BURST, 1);
        assertLife(playerA, 20);
    }

    private void preparePosition(int mountains) {
        addCard(Zone.BATTLEFIELD, playerA, "Mountain@fuel", mountains);
        addCard(Zone.HAND, playerA, BURST, 2);
        addCard(Zone.BATTLEFIELD, playerB, SHEOLDRED);
        setStrictChooseMode(true);
    }

    private void checkSheoldredDamage(int turn, PhaseStep step, int damage) {
        runCode("damage marked on Sheoldred", turn, step, playerA,
                (info, player, game) -> assertEquals(damage, getPermanent(SHEOLDRED, playerB).getDamage()));
    }

    private void finishFirstMain() {
        setStopAt(1, PhaseStep.BEGIN_COMBAT);
        execute();
    }
}
