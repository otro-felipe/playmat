package mage.view;

import mage.MageObject;
import mage.abilities.Ability;
import mage.cards.Card;
import mage.constants.AbilityType;
import mage.constants.Zone;
import mage.game.Game;
import mage.game.permanent.Permanent;
import mage.game.permanent.PermanentToken;
import mage.game.permanent.token.Token;
import mage.game.stack.StackAbility;
import org.jsoup.parser.Parser;

import java.io.Serializable;
import java.util.UUID;
import java.util.regex.Pattern;

/** Public source and declared text of one stack ability, independent of seat rules and hints. */
public final class PublicStackAbilityView implements Serializable {
    private static final long serialVersionUID = 1L;
    private static final Pattern FORMATTING = Pattern.compile("</?(?:b|i|em|strong)>|<br\\s*/?>", Pattern.CASE_INSENSITIVE);
    private static final Pattern UNSAFE_TEXT = Pattern.compile("[<>\\p{Cntrl}]");

    private final String kind;
    private final Source source;
    private final String effect;

    private PublicStackAbilityView(String kind, Source source, String effect) {
        this.kind = kind;
        this.source = source;
        this.effect = effect;
    }

    static PublicStackAbilityView capture(Game game, StackAbility ability) {
        AbilityType type = ability.getAbilityType();
        String kind = type.isTriggeredAbility() ? "triggered" : type.isActivatedAbility() ? "activated" : null;
        UUID id = ability.getSourceId();
        int incarnation = ability.getStackMomentSourceZCC();
        // GameState starts every object at one. Zero means the stack copy has no source witness.
        if (id == null || incarnation < 1) return new PublicStackAbilityView(kind, null, null);

        Zone current = game.getState().getZone(id);
        int currentIncarnation = game.getState().getZoneChangeCounter(id);
        boolean sameIncarnation = incarnation == currentIncarnation
                && (ability.getZone() != Zone.BATTLEFIELD || current == Zone.BATTLEFIELD);
        // A discard cost can publicly expose a card whose ability activated from the hand.
        boolean discarded = ability.getZone() == Zone.HAND && currentIncarnation == incarnation + 1
                && (current == Zone.GRAVEYARD || current == Zone.EXILED);
        MageObject source = null;
        UUID publicId = null;
        if (current != null && current.isPublicZone() && (sameIncarnation || discarded)) {
            source = game.getObjectReadOnly(id);
            // getObjectReadOnly can return a departed token from LKI even when the zone map still holds it.
            if (source instanceof Permanent && current != Zone.BATTLEFIELD) source = null;
            if (source != null) publicId = source.getId();
        }
        if (source == null && game.getState().getCommand().stream().anyMatch(item -> id.equals(item.getId()))) {
            source = game.getObjectReadOnly(id);
            publicId = id;
        }
        if (source == null) {
            source = game.getLastKnownBattlefieldInformation(id, incarnation);
        }
        if (source == null || source instanceof StackAbility || concealed(source, game)
                || source.getName() == null || source.getName().isEmpty()) {
            return new PublicStackAbilityView(kind, null, null);
        }

        Source presentation = new Source(source, publicId);
        // Only the printed face can supply the declaration. Resolving or dynamically granted abilities can
        // incorporate names of affected objects, choices and hints that do not belong in the public frame.
        MageObject printed = printedFace(source);
        String text = printed == null ? null : printed.getAbilities().stream()
                .filter(rule -> ability.getOriginalId().equals(rule.getOriginalId()) && rule.getAbilityType() == type)
                .findFirst().map(rule -> printedText(rule, presentation.name)).orElse(null);
        return new PublicStackAbilityView(kind, presentation, text);
    }

    private static MageObject printedFace(MageObject source) {
        if (!(source instanceof Permanent)) return source;
        MageObject basic = ((Permanent) source).getBasicMageObject();
        if (basic != null && source.getName().equals(basic.getName())) return basic;
        MageObject back = basic instanceof Card ? ((Card) basic).getSecondCardFace()
                : basic instanceof Token ? ((Token) basic).getBackFace() : null;
        return back != null && source.getName().equals(back.getName()) ? back : null;
    }

    private static boolean concealed(MageObject source, Game game) {
        if (source instanceof Card && ((Card) source).isFaceDown(game)) return true;
        if (!(source instanceof Permanent)) return false;
        Permanent permanent = (Permanent) source;
        return permanent.isMorphed() || permanent.isManifested() || permanent.isDisguised() || permanent.isCloaked();
    }

    private static String printedText(Ability declaration, String sourceName) {
        String rule = declaration.getRule(sourceName);
        if (rule == null) return null;
        String clean = Parser.unescapeEntities(FORMATTING.matcher(rule).replaceAll(" "), false).replaceAll("\\s+", " ").trim();
        return clean.isEmpty() || clean.length() > 1800 || UNSAFE_TEXT.matcher(clean).find() ? null : clean;
    }

    public static final class Source implements Serializable {
        private static final long serialVersionUID = 1L;

        private final UUID id;
        private final String name;
        private final String kind;
        private final String expansionSetCode;
        private final String cardNumber;

        private Source(MageObject object, UUID id) {
            this.id = id;
            this.name = object.getName();
            this.kind = object instanceof PermanentToken ? "token" : object instanceof Card ? "card" : "command";
            this.expansionSetCode = "card".equals(kind) ? object.getExpansionSetCode() : null;
            this.cardNumber = "card".equals(kind) ? object.getCardNumber() : null;
        }
    }
}
