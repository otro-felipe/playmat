package mage.abilities.keyword;

import mage.abilities.Ability;
import mage.abilities.StaticAbility;
import mage.abilities.effects.ContinuousEffectImpl;
import mage.abilities.hint.common.DayNightHint;
import mage.cards.Card;
import mage.cards.DoubleFacedCardHalf;
import mage.cards.TransformingDoubleFacedCard;
import mage.constants.*;
import mage.game.Game;
import mage.game.permanent.Permanent;
import mage.game.permanent.PermanentCard;

import java.util.UUID;

/**
 * @author TheElk801
 */
public class NightboundAbility extends StaticAbility {

    public NightboundAbility() {
        super(Zone.BATTLEFIELD, new NightboundEffect());
        this.addHint(DayNightHint.instance);
    }

    private NightboundAbility(final NightboundAbility ability) {
        super(ability);
    }

    @Override
    public String getRule() {
        return "nightbound <i>(If a player casts at least two spells during their own turn, it becomes day next turn.)</i>";
    }

    @Override
    public NightboundAbility copy() {
        return new NightboundAbility(this);
    }

    /** Only Aura faces can affect attachment checks before the permanent is created. */
    public static Card getEnteringFaceForAuraCheck(Card card, boolean faceDown, UUID controllerId, Game game) {
        Card back = card.getMainCard().getSecondCardFace();
        if (back == null || (!card.hasSubtype(SubType.AURA, game) && !back.hasSubtype(SubType.AURA, game))) {
            return card;
        }
        return entersOnNightFace(card, faceDown, controllerId, game) ? back : card;
    }

    public static boolean entersOnNightFace(Card card, boolean faceDown, UUID controllerId, Game game) {
        Card main = card.getMainCard();
        if (faceDown || !(main instanceof TransformingDoubleFacedCard) || !checkCard(main, game)
                || (card instanceof DoubleFacedCardHalf && ((DoubleFacedCardHalf) card).isBackSide())) {
            return false;
        }
        Card front = ((TransformingDoubleFacedCard) main).getLeftHalfCard();
        if (!game.getContinuousEffects().canModifyAbilitiesOnEntry(front.getId(), game)) {
            return front.getAbilities().containsClass(DayboundAbility.class);
        }

        // 614.12: evaluate the prospective front face under the battlefield's continuous effects.
        // Add it only in a simulation, without executing an entry event or collecting triggers.
        Game preview = game.createSimulationForPlayableCalc();
        Card previewFront = preview.getCard(front.getId());
        Zone fromZone = preview.getState().getZone(main.getId());
        if (fromZone != null) {
            previewFront.removeFromZone(preview, fromZone, null);
        }
        previewFront.setZone(Zone.BATTLEFIELD, preview);
        Permanent prospective = new PermanentCard(previewFront, controllerId, preview);
        preview.getContinuousEffects().setController(prospective.getId(), controllerId);
        preview.addPermanent(prospective, 0);
        preview.applyEffects();
        return prospective.getAbilities(preview).containsClass(DayboundAbility.class);
    }

    public static boolean checkCard(Card card, Game game) {
        return game.checkDayNight(false)
                && card.getSecondCardFace() != null
                && card.getSecondCardFace().getAbilities().containsClass(NightboundAbility.class);
    }
}

class NightboundEffect extends ContinuousEffectImpl {

    NightboundEffect() {
        super(Duration.WhileOnBattlefield, Layer.PlayerEffects, SubLayer.NA, Outcome.Benefit);
    }

    private NightboundEffect(final NightboundEffect effect) {
        super(effect);
    }

    @Override
    public NightboundEffect copy() {
        return new NightboundEffect(this);
    }

    @Override
    public boolean apply(Game game, Ability source) {
        if (!game.hasDayNight()) {
            // 702.145f
            // Any time a player controls a permanent that is back face up with nightbound and it’s day,
            // that player transforms that permanent. This happens immediately and isn’t a state-based action.
            game.setDaytime(false);
        }
        return true;
    }
}
