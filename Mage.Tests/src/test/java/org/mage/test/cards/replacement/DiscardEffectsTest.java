package org.mage.test.cards.replacement;

import mage.constants.PhaseStep;
import mage.constants.Zone;
import mage.game.trace.ReplayDecision;
import org.junit.Test;
import org.mage.test.serverside.base.CardTestPlayerBase;

import java.util.ArrayList;
import java.util.List;
import java.util.stream.Collectors;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;


/**
 *
 * @author escplan9 (Derek Monturo - dmontur1 at gmail dot com)
 */
public class DiscardEffectsTest extends CardTestPlayerBase {
    
    @Test
    public void testOpponentDiscardsLoxodonSmiter() {
        
        addCard(Zone.HAND, playerA, "Thoughtseize"); // {B} target player, discard non-land card, lose two life.
        addCard(Zone.BATTLEFIELD, playerA, "Swamp");
        // Loxodon Smiter can't be countered.
        // If a spell or ability an opponent controls causes you to discard Loxodon Smiter, put it onto the battlefield instead of putting it into your graveyard.
        addCard(Zone.HAND, playerB, "Loxodon Smiter");
        addCard(Zone.HAND, playerB, "Shock");
        addCard(Zone.HAND, playerB, "Mountain");


        castSpell(1, PhaseStep.PRECOMBAT_MAIN, playerA, "Thoughtseize");
        addTarget(playerA, playerB);
        setChoice(playerA, "Loxodon Smiter");
        setStopAt(1, PhaseStep.BEGIN_COMBAT);
        List<ReplayDecision> decisions = new ArrayList<>();
        try (ReplayDecision.Subscription ignored = ReplayDecision.observe(currentGame, decisions::add)) {
            execute();
        }
        List<ReplayDecision> choices = decisions.stream()
                .filter(decision -> decision.kind == ReplayDecision.Kind.SELECT)
                .collect(Collectors.toList());
        assertEquals(1, choices.size());
        ReplayDecision choice = choices.get(0);
        assertEquals(playerA.getId(), choice.chooserId);
        assertEquals(playerB.getId(), choice.affectedPlayerId);
        assertEquals("Thoughtseize", currentGame.getCard(choice.sourceId).getName());
        assertEquals(2, choice.cards.size());
        assertFalse(choice.cards.stream().anyMatch(card -> card.getName().equals("Mountain")));
        assertEquals(1, choice.selectedIds.size());
        assertEquals("Loxodon Smiter", currentGame.getCard(choice.selectedIds.get(0)).getName());

        
        assertLife(playerA, 18);
        assertGraveyardCount(playerA, "Thoughtseize", 1);
        assertGraveyardCount(playerB, "Loxodon Smiter", 0);
        assertPermanentCount(playerB, "Loxodon Smiter", 1);
    }
    
    @Test
    public void testOwnerDiscardsOwnLoxodonSmiter() {
        
        // Loxodon Smiter can't be countered.
        // If a spell or ability an opponent controls causes you to discard Loxodon Smiter, put it onto the battlefield instead of putting it into your graveyard.
        addCard(Zone.HAND, playerA, "Loxodon Smiter");
        addCard(Zone.HAND, playerA, "Sift"); // {3}{U} Sorcery - draw 3 discard 1
        addCard(Zone.BATTLEFIELD, playerA, "Island", 4);

        setStrictChooseMode(true);
        castSpell(1, PhaseStep.PRECOMBAT_MAIN, playerA, "Sift");
        setChoice(playerA, "Loxodon Smiter");
        setStopAt(1, PhaseStep.BEGIN_COMBAT);
        execute();
        
        assertGraveyardCount(playerA, "Sift", 1);
        assertGraveyardCount(playerA, "Loxodon Smiter", 1);
        assertPermanentCount(playerA, "Loxodon Smiter", 0);
    }
}
