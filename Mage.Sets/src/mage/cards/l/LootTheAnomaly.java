package mage.cards.l;

import mage.MageInt;
import mage.abilities.Ability;
import mage.abilities.common.CombatDamageByAbsolutePowerAbility;
import mage.abilities.common.SimpleActivatedAbility;
import mage.abilities.condition.common.ThresholdCondition;
import mage.abilities.costs.common.SacrificeTargetCost;
import mage.abilities.effects.common.InfoEffect;
import mage.abilities.effects.common.continuous.BoostSourceEffect;
import mage.cards.CardImpl;
import mage.cards.CardSetInfo;
import mage.constants.AbilityWord;
import mage.constants.CardType;
import mage.constants.Duration;
import mage.constants.SubType;
import mage.constants.SuperType;
import mage.filter.common.FilterControlledPermanent;
import mage.filter.predicate.Predicates;
import mage.filter.predicate.mageobject.AnotherPredicate;

import java.util.UUID;

public final class LootTheAnomaly extends CardImpl {

    private static final FilterControlledPermanent SACRIFICE_FILTER =
            new FilterControlledPermanent("another creature or planeswalker");

    static {
        SACRIFICE_FILTER.add(Predicates.or(CardType.CREATURE.getPredicate(), CardType.PLANESWALKER.getPredicate()));
        SACRIFICE_FILTER.add(AnotherPredicate.instance);
    }

    public LootTheAnomaly(UUID ownerId, CardSetInfo setInfo) {
        super(ownerId, setInfo, new CardType[]{CardType.CREATURE}, "{2}{B}");

        this.supertype.add(SuperType.LEGENDARY);
        this.subtype.add(SubType.BEAST);
        this.subtype.add(SubType.HORROR);
        this.power = new MageInt(-2);
        this.toughness = new MageInt(4);

        this.addAbility(CombatDamageByAbsolutePowerAbility.getInstance());

        Ability ability = new SimpleActivatedAbility(
                new BoostSourceEffect(-2, 0, Duration.EndOfTurn),
                new SacrificeTargetCost(SACRIFICE_FILTER)
        ).setCondition(ThresholdCondition.instance).setAbilityWord(AbilityWord.THRESHOLD);
        ability.addEffect(new InfoEffect("Activate only if there are seven or more cards in your graveyard"));
        this.addAbility(ability);
    }

    private LootTheAnomaly(final LootTheAnomaly card) {
        super(card);
    }

    @Override
    public LootTheAnomaly copy() {
        return new LootTheAnomaly(this);
    }
}
