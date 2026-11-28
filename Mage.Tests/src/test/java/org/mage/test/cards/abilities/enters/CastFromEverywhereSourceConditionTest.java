package org.mage.test.cards.abilities.enters;

import mage.constants.PhaseStep;
import mage.constants.Zone;
import org.junit.Test;
import org.mage.test.serverside.base.CardTestPlayerBase;

public class CastFromEverywhereSourceConditionTest extends CardTestPlayerBase {
    private static final String RING = "The One Ring";
    private static final String SUMMONER = "Null Summoner";

    // FRA-CAST-01: the Ring's protection goes to the player who both casts and controls it.
    @Test
    public void originalCasterGetsProtectionFromTheOneRing() {
        addCard(Zone.BATTLEFIELD, playerA, "Island", 4);
        addCard(Zone.HAND, playerA, RING);
        addCard(Zone.BATTLEFIELD, playerB, "Grizzly Bears");

        castSpell(1, PhaseStep.PRECOMBAT_MAIN, playerA, RING);
        attack(2, playerB, "Grizzly Bears");
        finish(2);

        assertLife(playerA, 20);
        assertPermanentCount(playerA, RING, 1);
    }

    // FRA-CAST-01: changing control of the spell does not transfer the fact of casting it.
    @Test
    public void aethersnatchDoesNotGiveTheRingsProtectionToEitherPlayer() {
        addCard(Zone.BATTLEFIELD, playerA, "Island", 4);
        addCard(Zone.HAND, playerA, RING);
        addCard(Zone.BATTLEFIELD, playerA, "Grizzly Bears");
        addCard(Zone.BATTLEFIELD, playerB, "Island", 6);
        addCard(Zone.BATTLEFIELD, playerB, "Silvercoat Lion");
        addCard(Zone.HAND, playerB, "Aethersnatch");

        castSpell(1, PhaseStep.PRECOMBAT_MAIN, playerA, RING);
        castSpell(1, PhaseStep.PRECOMBAT_MAIN, playerB, "Aethersnatch", RING, RING);
        attack(1, playerA, "Grizzly Bears");
        attack(2, playerB, "Silvercoat Lion");
        finish(2);

        assertLife(playerA, 18);
        assertLife(playerB, 18);
        assertPermanentCount(playerB, RING, 1);
    }

    // FRA-CAST-01: an entry replacement does not change the original caster.
    @Test
    public void gatherSpecimensDoesNotTriggerAStolenNullSummoner() {
        addSummonerAndMana();
        addCard(Zone.HAND, playerA, "Negate");
        addCard(Zone.BATTLEFIELD, playerB, "Island", 6);
        addCard(Zone.HAND, playerB, "Gather Specimens");
        addCard(Zone.HAND, playerB, "Shock");

        castSpell(1, PhaseStep.UPKEEP, playerB, "Gather Specimens");
        castSpell(1, PhaseStep.PRECOMBAT_MAIN, playerA, SUMMONER);
        finish(1);

        assertPermanentCount(playerB, SUMMONER, 1);
        assertHandCount(playerA, "Negate", 1);
        assertHandCount(playerB, "Shock", 1);
    }

    // FRA-CAST-01: copying a spell on the stack does not cast the resulting token.
    @Test
    public void directlyCopiedSpellDoesNotTriggerNullSummoner() {
        addSummonerAndMana();
        addCard(Zone.BATTLEFIELD, playerA, "Island", 4);
        addCard(Zone.BATTLEFIELD, playerA, "Lithoform Engine");
        addCard(Zone.HAND, playerB, "Shock");
        addCard(Zone.HAND, playerB, "Negate");

        castSpell(1, PhaseStep.PRECOMBAT_MAIN, playerA, SUMMONER);
        activateAbility(1, PhaseStep.PRECOMBAT_MAIN, playerA, "{4}, {T}: Copy", SUMMONER);
        addTarget(playerA, playerB);
        setChoice(playerA, "Shock");
        finish(1);

        assertPermanentCount(playerA, SUMMONER, 2);
        assertExileCount(playerB, "Shock", 1);
        assertHandCount(playerB, "Negate", 1);
    }

    // FRA-CAST-01: choosing to cast a copy of a card is still casting a spell.
    @Test
    public void actuallyCastingACopyTriggersNullSummoner() {
        addCard(Zone.BATTLEFIELD, playerA, "Wondrous Crucible");
        addCard(Zone.LIBRARY, playerA, "Island", 2);
        addCard(Zone.GRAVEYARD, playerA, SUMMONER);
        addCard(Zone.HAND, playerB, "Shock");
        skipInitShuffling();

        setChoice(playerA, true);
        addTarget(playerA, playerB);
        setChoice(playerA, "Shock");
        finish(1);

        assertPermanentCount(playerA, SUMMONER, 1);
        assertExileCount(playerA, SUMMONER, 1);
        assertExileCount(playerB, "Shock", 1);
    }

    private void addSummonerAndMana() {
        addCard(Zone.HAND, playerA, SUMMONER);
        addCard(Zone.BATTLEFIELD, playerA, "Island", 3);
        addCard(Zone.BATTLEFIELD, playerA, "Swamp");
    }

    private void finish(int turn) {
        setStrictChooseMode(true);
        setStopAt(turn, PhaseStep.END_TURN);
        execute();
    }
}
