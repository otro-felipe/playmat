package mage.player.human;

import mage.abilities.Ability;
import mage.abilities.Mode;
import mage.abilities.effects.common.UntapTargetEffect;
import mage.abilities.effects.keyword.EarthbendTargetEffect;
import mage.abilities.effects.common.continuous.GainAbilityTargetEffect;
import mage.abilities.keyword.HasteAbility;
import mage.cards.CardSetInfo;
import mage.cards.b.BadgermoleCub;
import mage.cards.h.Hydroform;
import mage.cards.n.NissaVitalForce;
import mage.constants.Duration;
import mage.constants.Rarity;
import mage.target.Target;
import mage.target.common.TargetLandPermanent;
import mage.target.targetpointer.SecondTargetPointer;
import org.junit.Test;

import java.io.Serializable;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;

import static org.junit.Assert.*;

public class TargetAnimationPromptTest {
    private final UUID owner = UUID.randomUUID();
    private final CardSetInfo printing = new CardSetInfo("Fixture", "TST", "1", Rarity.COMMON);

    private Map<String, Serializable> prompt(Ability source, Target target) {
        return HumanPlayer.getOptions(target, null, source);
    }

    @Test
    public void hydroformAndEarthbendDescribeWhatTheirEffectGrants() {
        Ability hydroform = new Hydroform(owner, printing).getSpellAbility();
        assertEquals("becomesCreature", prompt(hydroform, hydroform.getTargets().get(0)).get("targetAnimation"));

        Ability earthbend = new BadgermoleCub(owner, printing).getAbilities().stream()
                .filter(a -> !a.getTargets().isEmpty()).findFirst().get();
        assertEquals("grantsHaste", prompt(earthbend, earthbend.getTargets().get(0)).get("targetAnimation"));

        Ability nissa = new NissaVitalForce(owner, printing).getAbilities().stream()
                .filter(a -> a.getEffects().stream().anyMatch(e -> e instanceof UntapTargetEffect)).findFirst().get();
        assertEquals("grantsHaste", prompt(nissa, nissa.getTargets().get(0)).get("targetAnimation"));
    }

    @Test
    public void aSeparateHasteEffectMustAffectTheSameTargetAsTheAnimation() {
        Ability ability = new Hydroform(owner, printing).getSpellAbility();
        Target land = ability.getTargets().get(0);
        Target other = new TargetLandPermanent();
        ability.addTarget(other);
        ability.addEffect(new GainAbilityTargetEffect(HasteAbility.getInstance(), Duration.EndOfTurn)
                .setTargetPointer(new SecondTargetPointer()));
        assertEquals("becomesCreature", prompt(ability, land).get("targetAnimation"));
        assertFalse(prompt(ability, other).containsKey("targetAnimation"));
        ability.addEffect(new GainAbilityTargetEffect(HasteAbility.getInstance(), Duration.EndOfTurn));
        assertEquals("grantsHaste", prompt(ability, land).get("targetAnimation"));
    }

    @Test
    public void onlyTheTargetRoleInTheActiveModeIsMarked() {
        Ability ability = new Hydroform(owner, printing).getSpellAbility();
        Target first = ability.getTargets().get(0);
        Target second = new TargetLandPermanent();
        ability.addTarget(second);
        ability.addEffect(new EarthbendTargetEffect(1).setTargetPointer(new SecondTargetPointer()));
        assertEquals("becomesCreature", prompt(ability, first).get("targetAnimation"));
        assertEquals("grantsHaste", prompt(ability, second).get("targetAnimation"));

        Mode other = new Mode(new UntapTargetEffect());
        other.addTarget(new TargetLandPermanent());
        ability.addMode(other);
        ability.getModes().addSelectedMode(other.getId());
        ability.getModes().setActiveMode(other.getId());
        Map<String, Serializable> options = new HashMap<>();
        options.put("targetAnimation", "grantsHaste");
        assertFalse(HumanPlayer.getOptions(other.getTargets().get(0), options, ability).containsKey("targetAnimation"));
        assertFalse(prompt(ability, first).containsKey("targetAnimation"));
        assertFalse(prompt(null, second).containsKey("targetAnimation"));
    }
}
