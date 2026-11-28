package mage.cards.n;

import mage.MageInt;
import mage.abilities.Ability;
import mage.abilities.common.EntersBattlefieldTriggeredAbility;
import mage.abilities.common.SimpleStaticAbility;
import mage.abilities.condition.common.CastFromEverywhereSourceCondition;
import mage.abilities.condition.common.ThresholdCondition;
import mage.abilities.effects.AsThoughEffectImpl;
import mage.abilities.effects.AsThoughManaEffect;
import mage.abilities.effects.OneShotEffect;
import mage.cards.Card;
import mage.cards.CardImpl;
import mage.cards.CardSetInfo;
import mage.constants.AbilityWord;
import mage.constants.AsThoughEffectType;
import mage.constants.CardType;
import mage.constants.Duration;
import mage.constants.ManaType;
import mage.constants.Outcome;
import mage.constants.SubType;
import mage.constants.Zone;
import mage.filter.StaticFilters;
import mage.game.ExileZone;
import mage.game.Game;
import mage.players.ManaPoolItem;
import mage.players.Player;
import mage.target.TargetCard;
import mage.target.common.TargetOpponent;
import mage.util.CardUtil;

import java.util.UUID;

public final class NullSummoner extends CardImpl {

    public NullSummoner(UUID ownerId, CardSetInfo setInfo) {
        super(ownerId, setInfo, new CardType[]{CardType.CREATURE}, "{2}{U}{B}");
        this.subtype.add(SubType.HUMAN);
        this.subtype.add(SubType.WARLOCK);
        this.power = new MageInt(4);
        this.toughness = new MageInt(2);

        Ability exile = new EntersBattlefieldTriggeredAbility(new NullSummonerExileEffect())
                .withInterveningIf(CastFromEverywhereSourceCondition.instance);
        exile.addTarget(new TargetOpponent());
        this.addAbility(exile);

        Ability threshold = new SimpleStaticAbility(
                new NullSummonerPermission(AsThoughEffectType.CAST_FROM_NOT_OWN_HAND_ZONE)
                        .setText("As long as there are seven or more cards in your graveyard, you may cast the exiled card")
        );
        threshold.addEffect(new NullSummonerPermission(AsThoughEffectType.SPEND_OTHER_MANA)
                .setText(", and mana of any type can be spent to cast that spell"));
        this.addAbility(threshold.setAbilityWord(AbilityWord.THRESHOLD));
    }

    private NullSummoner(final NullSummoner card) {
        super(card);
    }

    @Override
    public NullSummoner copy() {
        return new NullSummoner(this);
    }
}

class NullSummonerExileEffect extends OneShotEffect {

    NullSummonerExileEffect() {
        super(Outcome.Exile);
        this.staticText = "target opponent reveals their hand. You choose a nonland card from it. Exile that card";
    }

    private NullSummonerExileEffect(final NullSummonerExileEffect effect) {
        super(effect);
    }

    @Override
    public NullSummonerExileEffect copy() {
        return new NullSummonerExileEffect(this);
    }

    @Override
    public boolean apply(Game game, Ability source) {
        Player controller = game.getPlayer(source.getControllerId());
        Player opponent = game.getPlayer(getTargetPointer().getFirst(game, source));
        if (controller == null || opponent == null) {
            return false;
        }
        opponent.revealCards(source, opponent.getHand(), game);
        if (opponent.getHand().count(StaticFilters.FILTER_CARD_NON_LAND, game) == 0) {
            return true;
        }

        TargetCard handChoice = new TargetCard(Zone.HAND, StaticFilters.FILTER_CARD_NON_LAND).withNotTarget(true);
        if (!controller.choose(outcome, opponent.getHand(), handChoice, source, game)) {
            return false;
        }
        Card card = opponent.getHand().get(handChoice.getFirstTarget(), game);
        UUID exileZoneId = CardUtil.getExileZoneId(game, source);
        if (card == null || !opponent.moveCardsToExile(card, source, game, true, exileZoneId, CardUtil.getSourceName(game, source))) {
            return false;
        }

        int exileVersion = game.getState().getZoneChangeCounter(card.getId());
        game.getState().setValue(NullSummonerPermission.exileKey(card.getId(), exileVersion), exileZoneId);
        return true;
    }
}

class NullSummonerPermission extends AsThoughEffectImpl implements AsThoughManaEffect {

    NullSummonerPermission(AsThoughEffectType type) {
        super(type, Duration.WhileOnBattlefield, Outcome.Benefit);
    }

    private NullSummonerPermission(final NullSummonerPermission effect) {
        super(effect);
    }

    @Override
    public NullSummonerPermission copy() {
        return new NullSummonerPermission(this);
    }

    @Override
    public boolean apply(Game game, Ability source) {
        return true;
    }

    @Override
    public boolean applies(UUID objectId, Ability source, UUID affectedControllerId, Game game) {
        if (!source.isControlledBy(affectedControllerId) || !ThresholdCondition.instance.apply(game, source)) {
            return false;
        }

        UUID cardId = CardUtil.getMainCardId(game, objectId);
        UUID exileZoneId = CardUtil.getCardExileZoneId(game, source);
        Zone zone = game.getState().getZone(cardId);
        if (zone == Zone.EXILED) {
            ExileZone exile = game.getExile().getExileZone(exileZoneId);
            return exile != null && exile.contains(cardId);
        }

        // A spell has already left exile by the time its mana cost is paid.
        return zone == Zone.STACK
                && getAsThoughEffectType() == AsThoughEffectType.SPEND_OTHER_MANA
                && exileZoneId.equals(game.getState().getValue(
                        exileKey(cardId, game.getState().getZoneChangeCounter(cardId) - 1)));
    }

    @Override
    public ManaType getAsThoughManaType(ManaType manaType, ManaPoolItem mana, UUID affectedControllerId, Ability source, Game game) {
        return mana.getFirstAvailable();
    }

    static String exileKey(UUID objectId, int zoneChangeCounter) {
        return "NullSummoner-exile-" + objectId + "-" + zoneChangeCounter;
    }
}
