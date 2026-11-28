package mage.cards.e;

import mage.abilities.Ability;
import mage.abilities.effects.OneShotEffect;
import mage.abilities.hint.common.OpenSideboardHint;
import mage.cards.Card;
import mage.cards.CardImpl;
import mage.cards.CardSetInfo;
import mage.cards.Cards;
import mage.cards.CardsImpl;
import mage.constants.CardType;
import mage.constants.Outcome;
import mage.constants.Zone;
import mage.filter.StaticFilters;
import mage.game.Game;
import mage.players.Player;
import mage.target.TargetCard;
import mage.target.common.TargetOpponent;
import mage.util.CardUtil;

import java.util.Set;
import java.util.UUID;

public final class ExtrapolateTheImpossible extends CardImpl {

    public ExtrapolateTheImpossible(UUID ownerId, CardSetInfo setInfo) {
        super(ownerId, setInfo, new CardType[]{CardType.SORCERY}, "{1}{B}");
        this.getSpellAbility().addEffect(new ExtrapolateTheImpossibleEffect());
        this.getSpellAbility().addHint(OpenSideboardHint.instance);
    }

    private ExtrapolateTheImpossible(final ExtrapolateTheImpossible card) {
        super(card);
    }

    @Override
    public ExtrapolateTheImpossible copy() {
        return new ExtrapolateTheImpossible(this);
    }
}

class ExtrapolateTheImpossibleEffect extends OneShotEffect {

    ExtrapolateTheImpossibleEffect() {
        super(Outcome.DrawCard);
        this.staticText = "You may reveal exactly two cards you own with different names from outside the game. "
                + "An opponent chooses one of them. You put that card into your hand";
    }

    private ExtrapolateTheImpossibleEffect(final ExtrapolateTheImpossibleEffect effect) {
        super(effect);
    }

    @Override
    public ExtrapolateTheImpossibleEffect copy() {
        return new ExtrapolateTheImpossibleEffect(this);
    }

    @Override
    public boolean apply(Game game, Ability source) {
        Player controller = game.getPlayer(source.getControllerId());
        if (controller == null) {
            return false;
        }

        Set<Card> sideboard = controller.getSideboard().getCards(game);
        sideboard.removeIf(card -> !card.isOwnedBy(controller.getId()));
        Cards possibleFirstCards = new CardsImpl();
        for (Card card : sideboard) {
            if (sideboard.stream().anyMatch(other -> !CardUtil.haveSameNames(other, card.getName(), game))) {
                possibleFirstCards.add(card);
            }
        }
        if (possibleFirstCards.isEmpty()
                || !controller.chooseUse(outcome, "Reveal two cards with different names from outside the game?", source, game)) {
            return true;
        }

        TargetCard first = new TargetCard(Zone.ALL, StaticFilters.FILTER_CARD)
                .withNotTarget(true);
        first.withChooseHint("first card to reveal");
        if (!controller.choose(outcome, possibleFirstCards, first, source, game)) {
            return false;
        }
        Card firstCard = game.getCard(first.getFirstTarget());
        sideboard.removeIf(card -> CardUtil.haveSameNames(card, firstCard.getName(), game));

        TargetCard second = new TargetCard(Zone.ALL, StaticFilters.FILTER_CARD)
                .withNotTarget(true);
        second.withChooseHint("card with a different name to reveal");
        if (!controller.choose(outcome, new CardsImpl(sideboard), second, source, game)) {
            return false;
        }
        Cards revealed = new CardsImpl(first.getTargets());
        revealed.addAll(second.getTargets());
        controller.revealCards(source, revealed, game);

        Set<UUID> opponents = game.getOpponents(controller.getId(), true);
        Player opponent;
        if (opponents.size() == 1) {
            opponent = game.getPlayer(opponents.iterator().next());
        } else {
            TargetOpponent chooser = new TargetOpponent(true);
            controller.choose(Outcome.Detriment, chooser, source, game);
            opponent = game.getPlayer(chooser.getFirstTarget());
        }
        if (opponent == null) {
            return false;
        }

        TargetCard selected = new TargetCard(Zone.ALL, StaticFilters.FILTER_CARD)
                .withNotTarget(true);
        selected.withChooseHint("card to put into the spell controller's hand");
        return opponent.choose(Outcome.Detriment, revealed, selected, source, game)
                && controller.moveCards(new CardsImpl(selected.getTargets()), Zone.HAND, source, game);
    }
}
