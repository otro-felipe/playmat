package org.mage.test.cards.single.fra;

import mage.constants.AbilityWord;
import mage.constants.PhaseStep;
import mage.constants.Zone;
import org.junit.Test;
import org.mage.test.player.TestPlayer;
import org.mage.test.serverside.base.CardTestPlayerBase;

public class LootTheAnomalyTest extends CardTestPlayerBase {

    private static final String LOOT = "Loot, the Anomaly";
    private static final String THRESHOLD = AbilityWord.THRESHOLD.formatWord() + "Sacrifice another creature or planeswalker";

    // FRA-LOOT-01: only creatures with Loot's static ability can assign their negative power.
    @Test
    public void assignsPositiveCombatDamageWhenAttacking() {
        addCard(Zone.BATTLEFIELD, playerA, LOOT);
        addCard(Zone.BATTLEFIELD, playerA, "Char-Rumbler");

        attack(1, playerA, LOOT);
        attack(1, playerA, "Char-Rumbler");
        finishCombat(1);

        assertLife(playerB, 18);
        assertPowerToughness(playerA, LOOT, -2, 4);
    }

    // FRA-LOOT-01: the same combat damage rule applies to defending creatures.
    @Test
    public void assignsPositiveCombatDamageWhenBlocking() {
        addCard(Zone.BATTLEFIELD, playerA, "Grizzly Bears");
        addCard(Zone.BATTLEFIELD, playerB, LOOT);

        attack(1, playerA, "Grizzly Bears");
        block(1, playerB, LOOT, "Grizzly Bears");
        finishCombat(1);

        assertGraveyardCount(playerA, "Grizzly Bears", 1);
        assertDamageReceived(playerB, LOOT, 2);
        assertLife(playerB, 20);
    }

    // FRA-LOOT-01: an effect that assigns damage by toughness takes precedence.
    @Test
    public void assignsToughnessDamageWithHighAlert() {
        addCard(Zone.BATTLEFIELD, playerA, LOOT);
        addCard(Zone.BATTLEFIELD, playerA, "High Alert");

        attack(1, playerA, LOOT);
        finishCombat(1);

        assertLife(playerB, 16);
        assertPowerToughness(playerA, LOOT, -2, 4);
    }

    // FRA-LOOT-01: effects outside combat still use the real power.
    @Test
    public void dealsNoPowerBasedNoncombatDamage() {
        addCard(Zone.BATTLEFIELD, playerA, LOOT);
        addCard(Zone.BATTLEFIELD, playerA, "Forest", 2);
        addCard(Zone.BATTLEFIELD, playerB, "Grizzly Bears");
        addCard(Zone.HAND, playerA, "Rabid Bite");

        castSpell(1, PhaseStep.PRECOMBAT_MAIN, playerA, "Rabid Bite", LOOT + "^Grizzly Bears");
        finishCombat(1);

        assertDamageReceived(playerB, "Grizzly Bears", 0);
        assertPowerToughness(playerA, LOOT, -2, 4);
    }

    // FRA-LOOT-02: below seven cards the ability is unavailable despite a legal sacrifice.
    @Test
    public void cannotActivateBelowThreshold() {
        addCard(Zone.BATTLEFIELD, playerA, LOOT);
        addCard(Zone.BATTLEFIELD, playerA, "Grizzly Bears");
        addCard(Zone.GRAVEYARD, playerA, "Forest", 6);
        checkPlayableAbility("Six cards do not meet threshold", 1, PhaseStep.PRECOMBAT_MAIN, playerA, THRESHOLD, false);

        finishCombat(1);
    }

    // FRA-LOOT-02: reaching threshold does not make Loot a legal sacrifice for its own ability.
    @Test
    public void cannotSacrificeItself() {
        addCard(Zone.BATTLEFIELD, playerA, LOOT);
        addCard(Zone.BATTLEFIELD, playerB, "Grizzly Bears");
        addCard(Zone.GRAVEYARD, playerA, "Forest", 7);
        checkPlayableAbility("No other permanent can be sacrificed", 1, PhaseStep.PRECOMBAT_MAIN, playerA, THRESHOLD, false);

        finishCombat(1);
    }

    // FRA-LOOT-02: the boost resolves after a response removes the graveyard.
    @Test
    public void canSacrificeAPlaneswalkerAndThresholdIsCheckedOnlyOnActivation() {
        addCard(Zone.BATTLEFIELD, playerA, LOOT);
        addCard(Zone.BATTLEFIELD, playerA, "Liliana of the Veil");
        addCard(Zone.GRAVEYARD, playerA, "Forest", 7);
        addCard(Zone.BATTLEFIELD, playerB, "Soul-Guide Lantern");

        checkPlayableAbility("Seven cards and a planeswalker meet the activation requirements",
                1, PhaseStep.PRECOMBAT_MAIN, playerA, THRESHOLD, true);
        activateAbility(1, PhaseStep.PRECOMBAT_MAIN, playerA, THRESHOLD);
        setChoice(playerA, "Liliana of the Veil");
        activateAbility(1, PhaseStep.PRECOMBAT_MAIN, playerB, "{T}, Sacrifice", TestPlayer.NO_TARGET, THRESHOLD);

        attack(1, playerA, LOOT);
        finishCombat(1);

        assertExileCount(playerA, "Forest", 7);
        assertExileCount(playerA, "Liliana of the Veil", 1);
        assertLife(playerB, 16);
        assertPowerToughness(playerA, LOOT, -4, 4);
    }

    private void finishCombat(int turn) {
        setStrictChooseMode(true);
        setStopAt(turn, PhaseStep.POSTCOMBAT_MAIN);
        execute();
    }
}
