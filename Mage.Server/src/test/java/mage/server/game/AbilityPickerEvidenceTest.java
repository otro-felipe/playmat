package mage.server.game;

import mage.abilities.SpellAbility;
import mage.cards.CardSetInfo;
import mage.cards.u.UnholyAnnexRitualChamber;
import mage.constants.AbilityType;
import mage.constants.MultiplayerAttackOption;
import mage.constants.RangeOfInfluence;
import mage.constants.Rarity;
import mage.constants.Zone;
import mage.game.Game;
import mage.game.GameImpl;
import mage.game.match.MatchType;
import mage.game.mulligan.LondonMulligan;
import mage.game.stack.Spell;
import mage.view.AbilityPickerView;
import mage.view.CardView;
import mage.view.GameView;
import org.junit.Test;

import java.util.Arrays;
import java.util.Set;
import java.util.UUID;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

public class AbilityPickerEvidenceTest {
    @Test
    public void visibleRoomPickerBindsThePhysicalCardAndExactStackFace() {
        UUID player = UUID.randomUUID();
        Game game = new PickerGame();
        UnholyAnnexRitualChamber room = new UnholyAnnexRitualChamber(player,
                new CardSetInfo("Unholy Annex // Ritual Chamber", "DSK", "118", Rarity.RARE));
        game.loadCards(Set.of(room), player);
        SpellAbility annex = room.getLeftHalfCard().getSpellAbility();
        SpellAbility chamber = room.getRightHalfCard().getSpellAbility();
        GameView gameView = new GameView(game.getState(), game, player, null);

        AbilityPickerView unavailable = new AbilityPickerView(gameView, room.getName(), room.getId(),
                Arrays.asList(annex, chamber), "Choose door");
        assertNull(unavailable.getSourceObjectId());
        assertNull(unavailable.getAbilityTypes());
        assertNull(unavailable.getSpellNames());

        gameView.getMyHand().put(room.getId(), new CardView(room));
        AbilityPickerView picker = new AbilityPickerView(gameView, room.getName(), room.getId(),
                Arrays.asList(annex, chamber), "Choose door");
        assertEquals(room.getId(), picker.getSourceObjectId());
        assertEquals(AbilityType.SPELL, picker.getAbilityTypes().get(annex.getId()));
        assertEquals("Unholy Annex", picker.getSpellNames().get(annex.getId()));
        assertEquals("Ritual Chamber", picker.getSpellNames().get(chamber.getId()));

        Spell spell = new Spell(room.getLeftHalfCard(), annex.copy(), player, Zone.HAND, game);
        game.getStack().add(spell);
        CardView onStack = new CardView(spell, game);
        assertEquals(room.getId(), onStack.getCardId());
        assertEquals(picker.getSpellNames().get(annex.getId()), onStack.getName());
    }

    private static final class PickerGame extends GameImpl {
        PickerGame() {
            super(MultiplayerAttackOption.LEFT, RangeOfInfluence.ALL, new LondonMulligan(0), 60, 20, 7);
        }

        @Override public MatchType getGameType() { return null; }
        @Override public int getNumPlayers() { return 2; }
        @Override public Game copy() { throw new UnsupportedOperationException(); }
    }
}
