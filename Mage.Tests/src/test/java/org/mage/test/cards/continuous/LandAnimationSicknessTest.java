package org.mage.test.cards.continuous;

import mage.constants.PhaseStep;
import mage.constants.Zone;
import mage.game.Game;
import mage.game.permanent.Permanent;
import mage.server.websocket.rpc.JsonCodec;
import mage.view.PermanentView;
import org.junit.Test;
import org.mage.test.serverside.base.CardTestPlayerBase;

import static org.junit.Assert.*;

public class LandAnimationSicknessTest extends CardTestPlayerBase {

    private void checkLand(Game game, String name, boolean creature, boolean sick) {
        Permanent land = getPermanent(name, playerA);
        assertEquals(creature, land.isCreature(game));
        assertEquals(sick, land.hasSummoningSickness());
        PermanentView seatView = new PermanentView(land, game.getCard(land.getId()), playerA.getId(), game);
        assertEquals(sick, JsonCodec.GSON.toJsonTree(seatView).getAsJsonObject().get("summoningSickness").getAsBoolean());
        assertEquals(!creature || !sick, land.canTap(game));
    }

    @Test
    public void newNoncreatureLandCanPayForAnInstant() {
        addCard(Zone.HAND, playerA, "Mountain");
        addCard(Zone.HAND, playerA, "Shock");
        playLand(1, PhaseStep.PRECOMBAT_MAIN, playerA, "Mountain");
        runCode("new noncreature land", 1, PhaseStep.PRECOMBAT_MAIN, playerA,
                (info, player, game) -> checkLand(game, "Mountain", false, true));
        castSpell(1, PhaseStep.PRECOMBAT_MAIN, playerA, "Shock", playerB);
        setStopAt(1, PhaseStep.POSTCOMBAT_MAIN);
        execute();
        assertTapped("Mountain", true);
        assertLife(playerB, 18);
    }

    @Test
    public void freshAndEstablishedLandsAnimatedByTheSameSpell() {
        addCard(Zone.BATTLEFIELD, playerA, "Island", 2);
        addCard(Zone.BATTLEFIELD, playerA, "Forest", 2);
        addCard(Zone.BATTLEFIELD, playerA, "Plains");
        addCard(Zone.HAND, playerA, "Mountain");
        addCard(Zone.HAND, playerA, "Hydroform", 2);
        playLand(1, PhaseStep.PRECOMBAT_MAIN, playerA, "Mountain");
        runCode("control duration before animation", 1, PhaseStep.PRECOMBAT_MAIN, playerA, (info, player, game) -> {
            checkLand(game, "Mountain", false, true);
            checkLand(game, "Plains", false, false);
        });
        castSpell(1, PhaseStep.PRECOMBAT_MAIN, playerA, "Hydroform", "Mountain", true);
        castSpell(1, PhaseStep.PRECOMBAT_MAIN, playerA, "Hydroform", "Plains", true);
        runCode("control duration after animation", 1, PhaseStep.BEGIN_COMBAT, playerA, (info, player, game) -> {
            checkLand(game, "Mountain", true, true);
            checkLand(game, "Plains", true, false);
            assertFalse(getPermanent("Mountain", playerA).canAttack(playerB.getId(), game));
        });
        attack(1, playerA, "Plains");
        setStopAt(1, PhaseStep.POSTCOMBAT_MAIN);
        execute();
        assertLife(playerB, 17);
    }

    @Test
    public void hasteFromFervorOnlyAppliesOnceTheLandIsACreature() {
        addCard(Zone.BATTLEFIELD, playerA, "Fervor");
        addCard(Zone.BATTLEFIELD, playerA, "Forest");
        addCard(Zone.BATTLEFIELD, playerA, "Island");
        addCard(Zone.HAND, playerA, "Mountain");
        addCard(Zone.HAND, playerA, "Hydroform");
        playLand(1, PhaseStep.PRECOMBAT_MAIN, playerA, "Mountain");
        runCode("before creature-only haste", 1, PhaseStep.PRECOMBAT_MAIN, playerA,
                (info, player, game) -> checkLand(game, "Mountain", false, true));
        castSpell(1, PhaseStep.PRECOMBAT_MAIN, playerA, "Hydroform", "Mountain", true);
        runCode("current haste", 1, PhaseStep.BEGIN_COMBAT, playerA, (info, player, game) -> {
            checkLand(game, "Mountain", true, false);
            assertFalse(getPermanent("Mountain", playerA).wasControlledFromStartOfControllerTurn());
        });
        attack(1, playerA, "Mountain");
        setStopAt(1, PhaseStep.POSTCOMBAT_MAIN);
        execute();
        assertLife(playerB, 17);
    }

    @Test
    public void takingControlOfAnEstablishedLandRestartsItsClock() {
        addCard(Zone.BATTLEFIELD, playerB, "Mountain");
        addCard(Zone.BATTLEFIELD, playerA, "Island", 5);
        addCard(Zone.BATTLEFIELD, playerA, "Forest");
        addCard(Zone.HAND, playerA, "Annex");
        addCard(Zone.HAND, playerA, "Hydroform");
        // Allow the land to see its original controller's turn before it changes hands.
        runCode("established under the original controller", 3, PhaseStep.PRECOMBAT_MAIN, playerA,
                (info, player, game) -> assertTrue(getPermanent("Mountain", playerB).wasControlledFromStartOfControllerTurn()));
        // Float four blue for Annex, leaving one Island and the Forest untapped for Hydroform.
        activateManaAbility(3, PhaseStep.PRECOMBAT_MAIN, playerA, "{T}: Add {U}", 4);
        castSpell(3, PhaseStep.PRECOMBAT_MAIN, playerA, "Annex", "Mountain", true);
        runCode("new controller", 3, PhaseStep.PRECOMBAT_MAIN, playerA,
                (info, player, game) -> checkLand(game, "Mountain", false, true));
        castSpell(3, PhaseStep.PRECOMBAT_MAIN, playerA, "Hydroform", "Mountain", true);
        runCode("still summoning sick", 3, PhaseStep.BEGIN_COMBAT, playerA,
                (info, player, game) -> checkLand(game, "Mountain", true, true));
        setStopAt(3, PhaseStep.POSTCOMBAT_MAIN);
        execute();
        assertLife(playerB, 20);
    }
}
