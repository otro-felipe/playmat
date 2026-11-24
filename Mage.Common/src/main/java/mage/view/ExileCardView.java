package mage.view;

import mage.abilities.Ability;
import mage.abilities.SpellAbility;
import mage.abilities.effects.ContinuousEffects;
import mage.cards.Card;
import mage.cards.CardWithSpellOption;
import mage.constants.AsThoughEffectType;
import mage.constants.SpellAbilityType;
import mage.constants.Zone;
import mage.game.ExileZone;
import mage.game.Game;
import mage.game.GameState;
import mage.game.permanent.Permanent;
import mage.players.Player;
import mage.util.CardUtil;

import java.io.Serializable;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.stream.Collectors;

import static mage.constants.AsThoughEffectType.CAST_ADVENTURE_FROM_NOT_OWN_HAND_ZONE;
import static mage.constants.AsThoughEffectType.CAST_FROM_NOT_OWN_HAND_ZONE;
import static mage.constants.AsThoughEffectType.PLAY_FROM_NOT_OWN_HAND_ZONE;

/** Public annotations for a face-up card currently in exile. */
public final class ExileCardView implements Serializable {
    private static final long serialVersionUID = 1L;
    private static final List<AsThoughEffectType> PERMISSIONS = Arrays.asList(
            PLAY_FROM_NOT_OWN_HAND_ZONE, CAST_FROM_NOT_OWN_HAND_ZONE, CAST_ADVENTURE_FROM_NOT_OWN_HAND_ZONE);

    private final UUID cardId;
    private final UUID sourceId;
    private final List<UUID> playableBy;

    private ExileCardView(UUID cardId, UUID sourceId, List<UUID> playableBy) {
        this.cardId = cardId;
        this.sourceId = sourceId;
        this.playableBy = playableBy.isEmpty() ? null : playableBy;
    }

    static List<ExileCardView> capture(GameState state, Game game) {
        List<ExileZone> zones = state.getExile().getExileZones().stream().filter(zone -> !zone.isEmpty()).collect(Collectors.toList());
        if (zones.isEmpty()) {
            return null;
        }
        Map<UUID, UUID> sources = new HashMap<>();
        for (Permanent permanent : state.getBattlefield().getAllPermanents()) {
            if (permanent.isFaceDown(game) || !permanent.isPhasedIn()) {
                continue;
            }
            // Only read the instance's existing key. The rules helper allocates a key when absent.
            String key = CardUtil.getObjectZoneString(CardUtil.SOURCE_EXILE_ZONE_TEXT, permanent, game);
            Object zoneId = state.getValue(key);
            if (zoneId instanceof UUID) {
                sources.put((UUID) zoneId, permanent.getId());
            }
        }
        boolean hasPermissionEffects = PERMISSIONS.stream().anyMatch(type ->
                !game.getContinuousEffects().getApplicableAsThoughEffects(type, game).isEmpty());
        Game permissionGame = null;
        List<ExileCardView> result = new ArrayList<>();
        for (ExileZone zone : zones) {
            UUID source = sources.get(zone.getId());
            for (Card card : zone.getCards(game)) {
                if (card.isFaceDown(game) || state.getZone(card.getId()) != Zone.EXILED) {
                    continue;
                }
                List<UUID> players = Collections.emptyList();
                if (hasPermissionEffects) {
                    // Some permission checks register alternative costs or discard stale effects.
                    // Query a rules simulation so view creation never changes the live game.
                    if (permissionGame == null) {
                        permissionGame = game.createSimulationForPlayableCalc();
                    }
                    players = permittedPlayers(card.getId(), permissionGame);
                }
                if (source != null || !players.isEmpty()) {
                    result.add(new ExileCardView(card.getId(), source, players));
                }
            }
        }
        result.sort(Comparator.comparing(entry -> entry.cardId));
        return result.isEmpty() ? null : result;
    }

    private static List<UUID> permittedPlayers(UUID cardId, Game game) {
        Card card = game.getCard(cardId);
        if (card == null) {
            return Collections.emptyList();
        }
        List<Ability> playAbilities = card.getAbilities(game).stream()
                .filter(ability -> isPlayAbility(card, ability, game)).collect(Collectors.toList());
        return game.getState().getPlayers().values().stream().filter(player -> !player.hasLeft())
                .map(Player::getId)
                .filter(player -> playAbilities.stream().anyMatch(ability -> hasPermission(ability, player, game)))
                .sorted().collect(Collectors.toList());
    }

    private static boolean isPlayAbility(Card card, Ability ability, Game game) {
        if (!ability.getAbilityType().isPlayCardAbility() || !ability.getZone().match(Zone.HAND)) {
            return false;
        }
        if (card instanceof CardWithSpellOption) {
            CardWithSpellOption options = (CardWithSpellOption) card;
            if (ability.getSourceId().equals(options.getSpellCard().getId())) {
                return options.isSpellCardCastOptionAvailable(game);
            }
            return options.isMainCardCastOptionAvailable(game);
        }
        if (ability instanceof SpellAbility) {
            switch (((SpellAbility) ability).getSpellAbilityType()) {
                case SPLIT:
                case SPLIT_AFTERMATH:
                case SPLIT_FUSED:
                case MODAL:
                case TRANSFORMED:
                case TRANSFORMED_RIGHT:
                    return false;
                default:
                    break;
            }
        }
        return true;
    }

    private static boolean hasPermission(Ability ability, UUID player, Game game) {
        ContinuousEffects effects = game.getContinuousEffects();
        UUID source = ability.getSourceId();
        if (!effects.asThough(source, PLAY_FROM_NOT_OWN_HAND_ZONE, ability, player, game).isEmpty()) {
            return true;
        }
        if (!(ability instanceof SpellAbility)) {
            return false;
        }
        return !effects.asThough(source, CAST_FROM_NOT_OWN_HAND_ZONE, ability, player, game).isEmpty()
                || (((SpellAbility) ability).getSpellAbilityType() == SpellAbilityType.ADVENTURE_SPELL
                && !effects.asThough(source, CAST_ADVENTURE_FROM_NOT_OWN_HAND_ZONE, ability, player, game).isEmpty());
    }
}
