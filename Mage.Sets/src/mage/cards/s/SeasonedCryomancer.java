package mage.cards.s;

import mage.MageInt;
import mage.abilities.Ability;
import mage.abilities.common.EntersBattlefieldTriggeredAbility;
import mage.abilities.common.SimpleActivatedAbility;
import mage.abilities.common.delayed.ReflexiveTriggeredAbility;
import mage.abilities.costs.common.ExileSourceFromGraveCost;
import mage.abilities.costs.mana.ManaCostsImpl;
import mage.abilities.effects.OneShotEffect;
import mage.abilities.effects.common.DrawCardSourceControllerEffect;
import mage.abilities.effects.common.TapTargetEffect;
import mage.abilities.effects.common.counter.AddCountersTargetEffect;
import mage.cards.CardImpl;
import mage.cards.CardSetInfo;
import mage.constants.CardType;
import mage.constants.Outcome;
import mage.constants.SubType;
import mage.constants.Zone;
import mage.counters.CounterType;
import mage.filter.StaticFilters;
import mage.game.Game;
import mage.players.Player;
import mage.target.common.TargetCreaturePermanent;

import java.util.UUID;

public final class SeasonedCryomancer extends CardImpl {

    public SeasonedCryomancer(UUID ownerId, CardSetInfo setInfo) {
        super(ownerId, setInfo, new CardType[]{CardType.CREATURE}, "{1}{U}{U}");

        this.subtype.add(SubType.HUMAN);
        this.subtype.add(SubType.WIZARD);
        this.power = new MageInt(2);
        this.toughness = new MageInt(2);

        this.addAbility(new EntersBattlefieldTriggeredAbility(new SeasonedCryomancerDiscardEffect()));

        Ability ability = new SimpleActivatedAbility(
                Zone.GRAVEYARD, new DrawCardSourceControllerEffect(2), new ManaCostsImpl<>("{3}{U}{U}")
        );
        ability.addCost(new ExileSourceFromGraveCost());
        this.addAbility(ability);
    }

    private SeasonedCryomancer(final SeasonedCryomancer card) {
        super(card);
    }

    @Override
    public SeasonedCryomancer copy() {
        return new SeasonedCryomancer(this);
    }
}

class SeasonedCryomancerDiscardEffect extends OneShotEffect {

    private static final String REFLEXIVE_TEXT = "tap up to that many target creatures and put a stun counter on each of them";

    SeasonedCryomancerDiscardEffect() {
        super(Outcome.Benefit);
        staticText = "draw two cards, then discard two cards. When you discard one or more nonland cards this way, "
                + REFLEXIVE_TEXT;
    }

    private SeasonedCryomancerDiscardEffect(final SeasonedCryomancerDiscardEffect effect) {
        super(effect);
    }

    @Override
    public SeasonedCryomancerDiscardEffect copy() {
        return new SeasonedCryomancerDiscardEffect(this);
    }

    @Override
    public boolean apply(Game game, Ability source) {
        Player player = game.getPlayer(source.getControllerId());
        if (player == null) {
            return false;
        }

        player.drawCards(2, source, game);
        int nonlands = player.discard(2, false, false, source, game)
                .count(StaticFilters.FILTER_CARD_NON_LAND, game);
        if (nonlands > 0) {
            ReflexiveTriggeredAbility reflexive = new ReflexiveTriggeredAbility(
                    new TapTargetEffect(), false, REFLEXIVE_TEXT
            );
            reflexive.addEffect(new AddCountersTargetEffect(CounterType.STUN.createInstance()));
            reflexive.addTarget(new TargetCreaturePermanent(0, nonlands));
            game.fireReflexiveTriggeredAbility(reflexive, source);
        }
        return true;
    }
}
