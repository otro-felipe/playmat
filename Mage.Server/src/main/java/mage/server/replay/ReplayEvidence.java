package mage.server.replay;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import mage.Mana;
import mage.abilities.Ability;
import mage.abilities.ActivatedAbility;
import mage.abilities.Mode;
import mage.cards.Card;
import mage.cards.Cards;
import mage.constants.PhaseStep;
import mage.constants.SpellAbilityCastMode;
import mage.constants.Zone;
import mage.game.Game;
import mage.game.events.GameEvent;
import mage.game.stack.Spell;
import mage.game.stack.StackObject;
import mage.game.trace.ReplayDecision;
import mage.game.trace.ReplayPrompt;
import mage.players.Player;
import mage.server.websocket.rpc.JsonCodec;
import mage.target.Target;
import mage.util.RandomUtil;
import mage.view.GameView;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Random;
import java.util.Set;
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

    /** Only card groups the current seat was shown, with no decision, library list or chat. */
    static JsonObject spectatorSeatKnowledge(JsonObject review, JsonObject publicView) {
        JsonObject result = new JsonObject();
        if (review == null) return result;
        for (Map.Entry<String, JsonElement> item : review.getAsJsonObject("seatViews").entrySet()) {
            JsonObject seat = item.getValue().getAsJsonObject(), known = new JsonObject();
            for (String key : new String[]{"lookedAt", "revealed"}) {
                JsonElement group = seat.has(key) ? seat.get(key) : publicView.get(key);
                if (group != null && group.isJsonArray()) known.add(key, group);
            }
            JsonArray players = seat.has("players") ? seat.getAsJsonArray("players") : publicView.getAsJsonArray("players");
            for (JsonElement element : players) {
                JsonObject player = element.getAsJsonObject();
                if (player.has("playerId") && item.getKey().equals(player.get("playerId").getAsString()) && player.has("topCard")) {
                    known.add("topCard", player.get("topCard"));
                }
            }
            result.add(item.getKey(), known);
        }
        return result;
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

    static final class PreparedPrompt {
        final JsonObject row;
        final Map<String, String> optionIds;

        PreparedPrompt(JsonObject row, Map<String, String> optionIds) {
            this.row = row;
            this.optionIds = optionIds;
        }
    }

    static PreparedPrompt prompt(Game game, ReplayPrompt offered, int frameCursor, long elapsed) {
        JsonObject row = new JsonObject();
        row.addProperty("kind", "action");
        row.addProperty("action", "select");
        row.addProperty("t", elapsed);
        row.addProperty("actorPlayerId", offered.actorId.toString());
        row.addProperty("decisionPlayerId", offered.chooserId.toString());
        row.addProperty("turn", game.getTurnNum());
        if (game.getState().getTurnStepType() != null) {
            row.addProperty("step", game.getState().getTurnStepType().name());
        }
        row.addProperty("preActionCursor", frameCursor);
        if (offered.sourceId != null) {
            row.addProperty("sourceId", offered.sourceId.toString());
        }
        if (offered.parentActionId != null) {
            row.addProperty("parentActionId", offered.parentActionId.toString());
        }
        JsonObject context = new JsonObject();
        context.addProperty("choiceKind", offered.kind.name().toLowerCase(Locale.ROOT));
        context.addProperty("prompt", offered.prompt);
        context.addProperty("optionCount", offered.optionCount);
        JsonArray options = new JsonArray();
        JsonArray labels = new JsonArray();
        JsonArray cards = new JsonArray();
        Map<String, String> ids = new LinkedHashMap<>();
        for (ReplayPrompt.Option option : offered.options) {
            JsonObject detail = new JsonObject();
            String id = option.card != null ? option.card.getId().toString()
                    : option.playerId != null ? option.playerId.toString() : "option-" + (ids.size() + 1);
            ids.put(option.id, id);
            detail.addProperty("id", id);
            if (option.label != null) {
                detail.addProperty("label", option.label);
                labels.add(option.label);
            }
            if (option.card != null) {
                JsonObject ref = cardRef(option.card, option.card.getId());
                detail.add("card", ref);
                cards.add(ref);
            }
            if (option.playerId != null) {
                detail.addProperty("playerId", option.playerId.toString());
            }
            options.add(detail);
        }
        context.add("options", labels);
        context.add("optionDetails", options);
        context.add("cards", cards);
        row.add("decision", context);
        return new PreparedPrompt(row, ids);
    }

    static void applyPromptAnswer(Game game, PreparedPrompt prepared, ReplayPrompt.Answer answer) {
        JsonObject context = prepared.row.getAsJsonObject("decision");
        if (!answer.selectedIds.isEmpty()) {
            UUID first = answer.selectedIds.get(0);
            context.addProperty("selectedId", first.toString());
            JsonArray ids = new JsonArray();
            for (UUID id : answer.selectedIds) {
                ids.add(id.toString());
            }
            context.add("selectedIds", ids);
            if (answer.selectedIds.size() == 1 && game.getPlayer(first) != null) {
                prepared.row.addProperty("affectedPlayerId", first.toString());
            }
        }
        JsonArray selected = new JsonArray();
        for (String key : answer.selections) {
            String id = prepared.optionIds.get(key);
            if (id != null) {
                selected.add(id);
            }
        }
        context.add("selectedOptionIds", selected);
        if (answer.text != null) {
            context.addProperty("selectedText", answer.text);
        }
        if (answer.declined) {
            context.addProperty("declined", true);
        }
    }

    static JsonObject decision(Game game, ReplayDecision committed, long elapsed) {
        JsonObject context = new JsonObject();
        if (committed.kind == ReplayDecision.Kind.PASS) {
            if (!describePass(game, committed, context)) {
                return null;
            }
        } else {
            JsonArray cards = new JsonArray();
            for (Card card : committed.cards) {
                cards.add(cardRef(card, card.getId()));
            }
            context.add("cards", cards);
        }

        JsonObject row = new JsonObject();
        row.addProperty("kind", "action");
        row.addProperty("action", committed.kind.name().toLowerCase(Locale.ROOT));
        row.addProperty("t", elapsed);
        row.addProperty("actorPlayerId", committed.actorId.toString());
        row.addProperty("decisionPlayerId", committed.chooserId.toString());
        row.addProperty("turn", game.getTurnNum());
        if (game.getState().getTurnStepType() != null) {
            row.addProperty("step", game.getState().getTurnStepType().name());
        }
        if (committed.kind == ReplayDecision.Kind.SELECT) {
            row.addProperty("affectedPlayerId", committed.affectedPlayerId.toString());
            context.addProperty("choiceKind", committed.choiceKind.name().toLowerCase(Locale.ROOT));
            if (committed.sourceId != null) {
                row.addProperty("sourceId", committed.sourceId.toString());
                Card source = game.getCard(committed.sourceId);
                if (source != null && !source.isFaceDown(game)) {
                    context.add("sourceCard", cardRef(source, committed.sourceId));
                }
            }
            if (!committed.selectedIds.isEmpty()) {
                UUID selected = committed.selectedIds.get(0);
                row.addProperty("objectId", selected.toString());
                context.addProperty("selectedId", selected.toString());
                JsonArray ids = new JsonArray();
                for (UUID id : committed.selectedIds) {
                    ids.add(id.toString());
                }
                context.add("selectedIds", ids);
            }
        }
        row.add("decision", context);
        return row;
    }

    private static boolean describePass(Game game, ReplayDecision committed, JsonObject context) {
        Player actor = game.getPlayer(committed.actorId);
        PhaseStep step = game.getState().getTurnStepType();
        int stackSize = game.getStack().size();
        boolean endsTurn = committed.actorId.equals(game.getActivePlayerId()) && step == PhaseStep.END_TURN;
        boolean manual = committed.passKind == ReplayDecision.PassKind.MANUAL;
        if (actor == null || (!manual && stackSize == 0 && !endsTurn)) {
            return false;
        }
        Set<UUID> playable = new LinkedHashSet<>();
        Set<UUID> manaSources = new LinkedHashSet<>();
        // As in the live game's playable view, the probe must not advance game randomness.
        Random before = RandomUtil.install(new Random(0));
        try {
            List<ActivatedAbility> options = actor.getPlayable(game, true);
            Game targetProbe = null;
            for (ActivatedAbility option : options) {
                UUID sourceId = option.getSourceId();
                if (sourceId == null) {
                    continue;
                }
                if (option.getModes().values().stream().anyMatch(mode -> !mode.getTargets().isEmpty())) {
                    if (targetProbe == null) {
                        targetProbe = game.createSimulationForPlayableCalc();
                    }
                    if (!option.canChooseTarget(targetProbe, actor.getId())) {
                        continue;
                    }
                }
                if (option.getAbilityType().isManaAbility()) {
                    manaSources.add(sourceId);
                } else {
                    playable.add(sourceId);
                }
            }
        } finally {
            RandomUtil.install(before);
        }
        int manaPool = actor.getManaPool().count();
        if (playable.isEmpty() && !(manual && stackSize > 0) && !(endsTurn && (manaPool > 0 || !manaSources.isEmpty()))) {
            return false;
        }
        context.addProperty("passKind", committed.passKind.name().toLowerCase(Locale.ROOT));
        context.addProperty("stackSize", stackSize);
        context.addProperty("endsTurn", endsTurn);
        context.add("manaPool", manaColors(actor.getManaPool().getMana()));
        context.addProperty("availableManaSources", manaSources.size());
        context.addProperty("playableCount", playable.size());
        JsonArray cards = new JsonArray();
        for (UUID id : playable) {
            if (cards.size() >= 24) {
                break;
            }
            Card card = game.getCard(id);
            if (card == null) {
                card = game.getPermanent(id);
            }
            if (card != null) {
                cards.add(cardRef(card, id));
            }
        }
        context.add("cards", cards);
        return true;
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
        row.add("paidMana", manaColors(payment));
    }

    private static JsonObject manaColors(Mana payment) {
        JsonObject colors = new JsonObject();
        addMana(colors, "W", payment.getWhite());
        addMana(colors, "U", payment.getBlue());
        addMana(colors, "B", payment.getBlack());
        addMana(colors, "R", payment.getRed());
        addMana(colors, "G", payment.getGreen());
        addMana(colors, "C", payment.getColorless());
        return colors;
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
