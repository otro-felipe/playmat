package mage.server.replay;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import mage.Mana;
import mage.abilities.Ability;
import mage.abilities.Mode;
import mage.cards.Card;
import mage.cards.Cards;
import mage.constants.SpellAbilityCastMode;
import mage.constants.Zone;
import mage.game.Game;
import mage.game.events.GameEvent;
import mage.game.stack.Spell;
import mage.game.stack.StackObject;
import mage.players.Player;
import mage.server.websocket.rpc.JsonCodec;
import mage.target.Target;
import mage.view.GameView;

import java.util.Collections;
import java.util.Map;
import java.util.UUID;

/** Builds protected archive evidence independently of live callback and watcher projections. */
final class ReplayEvidence {

    private static final String[] SEAT_FIELDS = {
            "stack", "exiles", "revealed", "lookedAt", "companion", "myHelperEmblems"
    };
    private static final String[] PLAYER_FIELDS = {
            "attachments", "battlefield", "commandList", "controlled", "counters", "designationNames",
            "exile", "graveyard", "handCount", "hasLeft", "hasPriority", "initiative", "isActive",
            "isHuman", "libraryCount", "life", "manaPool", "monarch", "name", "playerId", "topCard",
            "wins", "winsNeeded"
    };

    private ReplayEvidence() {
    }

    static String knowledgeKey(Game game) {
        StringBuilder key = new StringBuilder();
        appendCardGroups(key, game.getState().getRevealed());
        for (Player player : game.getPlayers().values()) {
            key.append('|').append(player.getId());
            for (UUID cardId : player.getHand()) {
                key.append(',').append(cardId);
            }
            appendCardGroups(key, game.getState().getLookedAt(player.getId()));
        }
        return key.toString();
    }

    private static void appendCardGroups(StringBuilder key, Map<String, Cards> groups) {
        for (Map.Entry<String, Cards> group : groups.entrySet()) {
            key.append('|').append(group.getKey()).append(':');
            for (UUID cardId : group.getValue()) {
                key.append(cardId).append(',');
            }
        }
    }

    static JsonObject protectedFrame(Game game, JsonObject spectator) {
        JsonObject seatViews = new JsonObject();
        JsonArray spectatorPlayers = replayPlayers(spectator.getAsJsonArray("players"));
        for (Player player : game.getPlayers().values()) {
            UUID playerId = player.getId();
            GameView perspective = GameView.forReplay(game, playerId, null);
            JsonObject visible = JsonCodec.GSON.toJsonTree(perspective).getAsJsonObject();
            JsonObject permitted = new JsonObject();
            permitted.addProperty("myPlayerId", playerId.toString());
            permitted.add("myHand", visible.get("myHand"));
            JsonArray visiblePlayers = replayPlayers(visible.getAsJsonArray("players"));
            if (!visiblePlayers.equals(spectatorPlayers)) {
                permitted.add("players", visiblePlayers);
            }
            for (String field : SEAT_FIELDS) {
                JsonElement value = visible.get(field);
                if (value != null && !value.equals(spectator.get(field))) {
                    permitted.add(field, value);
                }
            }
            seatViews.add(playerId.toString(), permitted);
        }
        JsonObject review = new JsonObject();
        review.add("seatViews", seatViews);
        return review;
    }

    static JsonObject spectatorFrame(GameView view) {
        JsonObject spectator = JsonCodec.GSON.toJsonTree(view).getAsJsonObject();
        spectator.add("players", replayPlayers(spectator.getAsJsonArray("players")));
        return spectator;
    }

    private static JsonArray replayPlayers(JsonArray players) {
        JsonArray result = new JsonArray();
        for (JsonElement entry : players) {
            JsonObject source = entry.getAsJsonObject();
            JsonObject allowed = new JsonObject();
            for (String field : PLAYER_FIELDS) {
                if (source.has(field)) {
                    allowed.add(field, source.get(field));
                }
            }
            result.add(allowed);
        }
        return result;
    }

    static JsonObject rulesEvent(Game game, GameEvent event, long elapsed) {
        if (event.getPlayerId() == null || event.getTargetId() == null) {
            return null;
        }
        JsonObject row = new JsonObject();
        row.addProperty("t", elapsed);
        row.addProperty("actorPlayerId", event.getPlayerId().toString());
        row.addProperty("turn", game.getTurnNum());
        if (game.getState().getTurnStepType() != null) {
            row.addProperty("step", game.getState().getTurnStepType().name());
        }
        if (event.getType() == GameEvent.EventType.DREW_CARD) {
            row.addProperty("kind", "draw");
            Card drawn = game.getCard(event.getTargetId());
            if (drawn != null) {
                row.add("card", cardRef(drawn, event.getTargetId()));
            }
            return row;
        }
        row.addProperty("kind", "action");
        UUID objectId = event.getTargetId();
        switch (event.getType()) {
            case SPELL_CAST:
                row.addProperty("action", "cast");
                Spell spell = game.getSpell(event.getTargetId());
                if (spell != null) {
                    objectId = spell.getId();
                    if (!spell.isFaceDown(game)) {
                        row.add("card", cardRef(spell, spell.getSourceId()));
                        row.addProperty("sourceId", spell.getSourceId().toString());
                        SpellAbilityCastMode castMode = spell.getSpellAbility().getSpellAbilityCastMode();
                        if (castMode != SpellAbilityCastMode.NORMAL) {
                            row.addProperty("castMode", castMode.toString());
                        }
                    }
                    describeAbilities(row, spell.getSpellAbilities(), !spell.isFaceDown(game));
                }
                break;
            case LAND_PLAYED:
                row.addProperty("action", "land");
                Card land = game.getCard(event.getTargetId());
                if (land != null && !land.isFaceDown(game)) {
                    row.add("card", cardRef(land, event.getTargetId()));
                }
                break;
            case ACTIVATED_ABILITY:
                row.addProperty("action", "activate");
                StackObject activation = game.getStack().getStackObject(event.getTargetId());
                if (activation != null) {
                    UUID sourceId = activation.getSourceId();
                    boolean sourcePublic = addPublicSource(row, game, sourceId);
                    describeAbilities(row, Collections.singletonList(activation.getStackAbility()), sourcePublic);
                }
                break;
            case ATTACKER_DECLARED:
            case BLOCKER_DECLARED:
                if (event.getSourceId() == null) {
                    return null;
                }
                row.addProperty("action", event.getType() == GameEvent.EventType.ATTACKER_DECLARED ? "attack" : "block");
                objectId = event.getSourceId();
                addPublicSource(row, game, objectId);
                JsonArray target = new JsonArray();
                target.add(event.getTargetId().toString());
                row.add("targetIds", target);
                break;
            default:
                return null;
        }
        row.addProperty("objectId", objectId.toString());
        if (event.getZone() != null) {
            row.addProperty("fromZone", event.getZone().name());
        }
        return row;
    }

    private static boolean addPublicSource(JsonObject row, Game game, UUID id) {
        if (id == null) {
            return false;
        }
        Card card = game.getPermanent(id);
        Zone zone = game.getState().getZone(id);
        if (card == null && (zone == Zone.GRAVEYARD || zone == Zone.EXILED || zone == Zone.COMMAND)) {
            card = game.getCard(id);
        }
        if (card == null || card.isFaceDown(game)) {
            return false;
        }
        row.addProperty("sourceId", id.toString());
        row.add("card", cardRef(card, id));
        return true;
    }

    private static void describeAbilities(JsonObject row, Iterable<? extends Ability> abilities, boolean includeModes) {
        JsonArray targets = new JsonArray();
        JsonArray modes = new JsonArray();
        Mana payment = new Mana();
        for (Ability ability : abilities) {
            payment.add(ability.getManaCostsToPay().getPayment());
            for (UUID selected : ability.getModes().getSelectedModes()) {
                Mode mode = ability.getModes().get(selected);
                if (mode == null) {
                    continue;
                }
                if (includeModes && ability.isModal()) {
                    modes.add(mode.getEffects().getText(mode));
                }
                for (Target target : mode.getTargets()) {
                    for (UUID id : target.getTargets()) {
                        targets.add(id.toString());
                    }
                }
            }
        }
        row.add("targetIds", targets);
        if (modes.size() > 0) {
            row.add("modes", modes);
        }
        JsonObject colors = new JsonObject();
        addMana(colors, "W", payment.getWhite());
        addMana(colors, "U", payment.getBlue());
        addMana(colors, "B", payment.getBlack());
        addMana(colors, "R", payment.getRed());
        addMana(colors, "G", payment.getGreen());
        addMana(colors, "C", payment.getColorless());
        row.add("paidMana", colors);
    }

    private static void addMana(JsonObject colors, String symbol, int amount) {
        if (amount > 0) {
            colors.addProperty(symbol, amount);
        }
    }

    private static JsonObject cardRef(Card card, UUID id) {
        JsonObject ref = new JsonObject();
        ref.addProperty("id", id.toString());
        ref.addProperty("name", card.getName());
        ref.addProperty("setCode", card.getExpansionSetCode());
        ref.addProperty("cardNumber", card.getCardNumber());
        return ref;
    }
}
