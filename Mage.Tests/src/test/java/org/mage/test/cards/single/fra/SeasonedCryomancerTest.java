package org.mage.test.cards.single.fra;

import mage.constants.PhaseStep;
import mage.constants.Zone;
import mage.counters.CounterType;
import org.junit.Test;
import org.mage.test.player.TestPlayer;
import org.mage.test.serverside.base.CardTestPlayerBase;

public class SeasonedCryomancerTest extends CardTestPlayerBase {

    private static final String CRYOMANCER = "Seasoned Cryomancer";
    private static final String BEARS = "Grizzly Bears";
    private static final String LION = "Silvercoat Lion";

    // FRA-CRYO-01: the new cards can be discarded, and two nonlands allow two targets.
    @Test
    public void drawsBeforeDiscardingAndStunsBothTargets() {
        addCard(Zone.LIBRARY, playerA, "Opt", 2);
        skipInitShuffling();
        addCard(Zone.BATTLEFIELD, playerB, BEARS);
        addCard(Zone.BATTLEFIELD, playerB, LION, 1, true);

        castCryomancer();
        addTarget(playerA, BEARS + "^" + LION);
        finishTurn();

        assertHandCount(playerA, 0);
        assertGraveyardCount(playerA, "Opt", 2);
        assertTapped(BEARS, true);
        assertTapped(LION, true);
        assertCounterCount(playerB, BEARS, CounterType.STUN, 1);
        assertCounterCount(playerB, LION, CounterType.STUN, 1);
    }

    // FRA-CRYO-01: a land discard does not contribute a target.
    @Test
    public void tapsOneCreatureAfterDiscardingOneNonlandAndOneLand() {
        addCard(Zone.LIBRARY, playerA, "Opt");
        addCard(Zone.LIBRARY, playerA, "Forest");
        skipInitShuffling();
        addCard(Zone.BATTLEFIELD, playerB, BEARS);
        addCard(Zone.BATTLEFIELD, playerB, LION);

        castCryomancer();
        addTarget(playerA, BEARS);
        finishTurn();

        assertGraveyardCount(playerA, "Opt", 1);
        assertGraveyardCount(playerA, "Forest", 1);
        assertTapped(BEARS, true);
        assertTapped(LION, false);
        assertCounterCount(playerB, BEARS, CounterType.STUN, 1);
        assertCounterCount(playerB, LION, CounterType.STUN, 0);
    }

    // FRA-CRYO-01: no reflexive trigger occurs after discarding only lands.
    @Test
    public void doesNotTriggerAfterDiscardingOnlyLands() {
        addCard(Zone.LIBRARY, playerA, "Forest", 2);
        skipInitShuffling();
        addCard(Zone.BATTLEFIELD, playerB, BEARS);

        castCryomancer();
        finishTurn();

        assertGraveyardCount(playerA, "Forest", 2);
        assertTapped(BEARS, false);
        assertCounterCount(playerB, BEARS, CounterType.STUN, 0);
    }

    // FRA-CRYO-01: the reflexive trigger allows choosing zero targets.
    @Test
    public void allowsChoosingNoTargets() {
        addCard(Zone.LIBRARY, playerA, "Opt", 2);
        skipInitShuffling();
        addCard(Zone.BATTLEFIELD, playerB, BEARS);

        castCryomancer();
        addTarget(playerA, TestPlayer.TARGET_SKIP);
        finishTurn();

        assertGraveyardCount(playerA, "Opt", 2);
        assertTapped(BEARS, false);
        assertCounterCount(playerB, BEARS, CounterType.STUN, 0);
    }

    // FRA-CRYO-01: the reflexive trigger is a separate stack object that opponents can respond to.
    @Test
    public void canRespondAfterTheDiscardAndBeforeTheStun() {
        addCard(Zone.LIBRARY, playerA, "Opt", 2);
        skipInitShuffling();
        addCard(Zone.BATTLEFIELD, playerB, "Island");
        addCard(Zone.HAND, playerB, "Unsummon");
        addCard(Zone.BATTLEFIELD, playerB, BEARS);
        addCard(Zone.BATTLEFIELD, playerB, LION);

        castCryomancer();
        addTarget(playerA, BEARS + "^" + LION);
        castSpell(1, PhaseStep.PRECOMBAT_MAIN, playerB, "Unsummon", BEARS, "Tap up to that many target creatures");
        finishTurn();

        assertGraveyardCount(playerA, "Opt", 2);
        assertHandCount(playerB, BEARS, 1);
        assertTapped(LION, true);
        assertCounterCount(playerB, LION, CounterType.STUN, 1);
    }

    // FRA-CRYO-02: activating from the graveyard exiles the Cryomancer and draws two cards.
    @Test
    public void exilesFromTheGraveyardToDrawTwo() {
        addCard(Zone.GRAVEYARD, playerA, CRYOMANCER);
        addCard(Zone.BATTLEFIELD, playerA, "Island", 5);
        addCard(Zone.LIBRARY, playerA, "Opt", 2);
        skipInitShuffling();

        activateAbility(1, PhaseStep.PRECOMBAT_MAIN, playerA, "{3}{U}{U}, Exile this card from your graveyard");
        finishTurn();

        assertExileCount(playerA, CRYOMANCER, 1);
        assertGraveyardCount(playerA, CRYOMANCER, 0);
        assertHandCount(playerA, "Opt", 2);
    }

    private void castCryomancer() {
        addCard(Zone.HAND, playerA, CRYOMANCER);
        addCard(Zone.BATTLEFIELD, playerA, "Island", 3);
        castSpell(1, PhaseStep.PRECOMBAT_MAIN, playerA, CRYOMANCER);
    }

    private void finishTurn() {
        setStrictChooseMode(true);
        setStopAt(1, PhaseStep.END_TURN);
        execute();
    }
}
