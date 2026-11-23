package mage.abilities.effects.common.continuous;

import mage.abilities.Ability;
import mage.abilities.effects.Effect;
import mage.abilities.effects.keyword.EarthbendTargetEffect;
import mage.abilities.keyword.HasteAbility;
import mage.constants.CardType;
import mage.target.targetpointer.NthTargetPointer;

/** The selected mode's direct effect on this target, independent of its eventual combat legality. */
public enum TargetAnimation {
    BECOMES_CREATURE("becomesCreature"),
    GRANTS_HASTE("grantsHaste");

    private final String wireValue;

    TargetAnimation(String wireValue) {
        this.wireValue = wireValue;
    }

    public String wireValue() {
        return wireValue;
    }

    public static TargetAnimation forRole(Ability source, int role) {
        boolean animation = false;
        boolean haste = false;
        for (Effect effect : source.getEffects()) {
            if (!(effect.getTargetPointer() instanceof NthTargetPointer)
                    || ((NthTargetPointer) effect.getTargetPointer()).getTargetIndex() != role
                    || effect.getCondition() != null) {
                continue;
            }
            if (effect instanceof EarthbendTargetEffect) {
                return GRANTS_HASTE;
            }
            if (effect instanceof BecomesCreatureTargetEffect) {
                BecomesCreatureTargetEffect becomes = (BecomesCreatureTargetEffect) effect;
                if (becomes.token.getCardType().contains(CardType.CREATURE)) {
                    animation = true;
                    haste |= becomes.token.getAbilities().containsClass(HasteAbility.class);
                }
            }
            if (effect instanceof GainAbilityTargetEffect
                    && ((GainAbilityTargetEffect) effect).ability instanceof HasteAbility) {
                haste = true;
            }
        }
        if (!animation) {
            return null;
        }
        return haste ? GRANTS_HASTE : BECOMES_CREATURE;
    }
}
