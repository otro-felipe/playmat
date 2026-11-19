package mage.game.trace;

import mage.abilities.Ability;
import mage.cards.Card;
import mage.cards.Cards;
import mage.choices.Choice;
import mage.constants.Zone;
import mage.game.Game;
import mage.game.stack.Spell;
import mage.game.stack.StackAbility;
import mage.game.stack.StackObject;
import mage.players.Player;
import mage.target.Target;

import java.util.ArrayList;
import java.util.Collection;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.function.Consumer;

/** The choices the acting player could see before an engine-validated response. */
public final class ReplayPrompt {

    public enum Kind { TARGET, CARDS, SEARCH, MODE, CHOICE, USE, AMOUNT, PILE, ABILITY, REPLACEMENT }

    private static final int MAX_OPTIONS = 48;
    private static final int MAX_LABEL = 400;
    public static final Consumer<Answer> NO_CAPTURE = ignored -> { };

    public static final class Option {
        public final String id;
        public final String label;
        public final Card card;
        public final UUID playerId;

        private Option(String id, String label, Card card, UUID playerId) {
            this.id = id;
            this.label = limit(label);
            this.card = card;
            this.playerId = playerId;
        }
    }

    public static final class Answer {
        public final List<String> selections;
        public final List<UUID> selectedIds;
        public final String text;
        public final boolean declined;

        private Answer(Collection<String> selections, Collection<UUID> selectedIds, String text, boolean declined) {
            this.selections = new ArrayList<>(selections);
            this.selectedIds = new ArrayList<>(selectedIds);
            this.text = limit(text);
            this.declined = declined;
        }

        public static Answer selection(Collection<UUID> ids) {
            List<String> options = new ArrayList<>();
            for (UUID id : ids) {
                options.add(id.toString());
            }
            return new Answer(options, ids, null, ids.isEmpty());
        }

        public static Answer option(String key, String label) {
            return new Answer(Collections.singletonList(key), Collections.emptyList(), label, false);
        }

        public static Answer decline() {
            return new Answer(Collections.emptyList(), Collections.emptyList(), null, true);
        }
    }

    public final Kind kind;
    public final UUID actorId;
    public final UUID chooserId;
    public final UUID sourceId;
    public final UUID parentActionId;
    public final String prompt;
    public final List<Option> options;
    public final int optionCount;

    private ReplayPrompt(Game game, Player actor, Ability source, Kind kind, String prompt, List<Option> options, int optionCount) {
        this.kind = kind;
        this.actorId = actor.getId();
        this.chooserId = actor.getTurnControlledBy();
        this.sourceId = source == null ? null : source.getSourceId();
        this.parentActionId = announcingAction(game, source);
        this.prompt = limit(prompt);
        this.options = Collections.unmodifiableList(options);
        this.optionCount = optionCount;
    }

    private static String limit(String text) {
        return text == null || text.length() <= MAX_LABEL ? text : text.substring(0, MAX_LABEL);
    }

    private static UUID announcingAction(Game game, Ability source) {
        if (source == null) {
            return null;
        }
        StackObject object = game.getStack().getFirstOrNull();
        if (object instanceof Spell) {
            Spell spell = (Spell) object;
            if (!spell.isResolving() && !spell.getSpellAbility().isActivated()
                    && spell.getSpellAbilities().stream().anyMatch(ability -> ability.getId().equals(source.getId()))) {
                return spell.getId();
            }
        }
        if (object instanceof StackAbility && !((StackAbility) object).isActivated()
                && object.getStackAbility().getId().equals(source.getId())) {
            return object.getId();
        }
        return null;
    }

    public static Consumer<Answer> targets(Game game, Player actor, Ability source, Target target,
                                           Collection<UUID> candidates, Cards shown) {
        return ReplayDecision.offer(game, () -> {
            List<Option> options = new ArrayList<>();
            for (UUID id : candidates) {
                if (options.size() >= MAX_OPTIONS) {
                    break;
                }
                Player player = game.getPlayer(id);
                if (player != null) {
                    options.add(new Option(id.toString(), player.getName(), null, id));
                } else {
                    Card card = visibleCard(game, actor, id, shown);
                    options.add(new Option(id.toString(), card == null ? null : card.getName(), card, null));
                }
            }
            Kind kind = target.getZone() == Zone.LIBRARY ? Kind.SEARCH : shown == null ? Kind.TARGET : Kind.CARDS;
            return new ReplayPrompt(game, actor, source, kind, target.getMessage(game), options, candidates.size());
        });
    }

    private static Card visibleCard(Game game, Player actor, UUID id, Cards shown) {
        Zone zone = game.getState().getZone(id);
        boolean exposed = shown != null && shown.contains(id)
                || zone == Zone.HAND && actor.getHand().contains(id)
                || zone == Zone.BATTLEFIELD || zone == Zone.GRAVEYARD || zone == Zone.STACK || zone == Zone.COMMAND
                || game.getState().getRevealed().values().stream().anyMatch(cards -> cards.contains(id))
                || game.getState().getLookedAt(actor.getTurnControlledBy()).values().stream().anyMatch(cards -> cards.contains(id));
        if (!exposed) {
            return null;
        }
        Card card = game.getCard(id);
        if (card == null) {
            card = game.getPermanent(id);
        }
        return card == null || card.isFaceDown(game) ? null : card;
    }

    public static Consumer<Answer> labels(Game game, Player actor, Ability source, Kind kind, String prompt,
                                                   Map<?, String> labels) {
        return ReplayDecision.offer(game, () -> {
            List<Option> options = new ArrayList<>();
            for (Map.Entry<?, String> entry : labels.entrySet()) {
                if (options.size() >= MAX_OPTIONS) {
                    break;
                }
                options.add(new Option(String.valueOf(entry.getKey()), entry.getValue(), null, null));
            }
            return new ReplayPrompt(game, actor, source, kind, prompt, options, labels.size());
        });
    }

    public static Consumer<Answer> choices(Game game, Player actor, Choice choice) {
        if (choice.isKeyChoice()) {
            return labels(game, actor, null, Kind.CHOICE, choice.getMessage(), choice.getKeyChoices());
        }
        return ReplayDecision.offer(game, () -> {
            List<Option> options = new ArrayList<>();
            for (String label : choice.getChoices()) {
                if (options.size() >= MAX_OPTIONS) {
                    break;
                }
                options.add(new Option(label, label, null, null));
            }
            return new ReplayPrompt(game, actor, null, Kind.CHOICE, choice.getMessage(), options, choice.getChoices().size());
        });
    }

    public static Consumer<Answer> amount(Game game, Player actor, Ability source, String prompt, int min, int max) {
        return ReplayDecision.offer(game, () -> {
            String range = min + "–" + max;
            Option allowed = new Option("range", range, null, null);
            long options = (long) max - min + 1;
            return new ReplayPrompt(game, actor, source, Kind.AMOUNT, prompt, Collections.singletonList(allowed),
                    (int) Math.min(options, Integer.MAX_VALUE));
        });
    }

    public static Consumer<Answer> piles(Game game, Player actor, String prompt, List<? extends Card> first,
                                        List<? extends Card> second) {
        return ReplayDecision.offer(game, () -> {
            List<Option> options = new ArrayList<>();
            options.add(new Option("first", pileLabel(1, first), null, null));
            options.add(new Option("second", pileLabel(2, second), null, null));
            return new ReplayPrompt(game, actor, null, Kind.PILE, prompt, options, 2);
        });
    }

    private static String pileLabel(int number, List<? extends Card> cards) {
        StringBuilder label = new StringBuilder("Pile ").append(number);
        if (cards != null && !cards.isEmpty()) {
            label.append(" (").append(cards.size()).append("): ");
            for (Card card : cards) {
                if (label.length() >= MAX_LABEL) {
                    break;
                }
                label.append(card.getName()).append(", ");
            }
            label.setLength(label.length() - 2);
        }
        return label.toString();
    }
}
