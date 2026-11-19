package mage.players;

import mage.abilities.Ability;
import mage.abilities.ActivatedAbility;
import mage.abilities.PlayLandAbility;
import mage.abilities.SpellAbility;
import mage.abilities.mana.BasicManaAbility;
import mage.abilities.costs.common.TapSourceCost;
import mage.abilities.effects.mana.BasicManaEffect;
import mage.constants.AbilityType;
import mage.constants.ManaType;
import mage.constants.SpellAbilityType;
import mage.util.Copyable;

import java.io.Serializable;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.UUID;
import java.util.stream.Collectors;

/**
 * Contains stats with playable abilities for one object
 *
 * @author JayDi85
 */
public class PlayableObjectStats implements Serializable, Copyable<PlayableObjectStats> {

    // map: ability.id -> ability.rules
    List<PlayableObjectRecord> basicManaAbilities = new ArrayList<>();
    List<PlayableObjectRecord> basicPlayAbilities = new ArrayList<>();
    List<PlayableObjectRecord> basicCastAbilities = new ArrayList<>();
    List<PlayableObjectRecord> other = new ArrayList<>();

    public PlayableObjectStats() {
    }

    public PlayableObjectStats(List<ActivatedAbility> activatedAbilities) {
        load(activatedAbilities);
    }

    public void load(List<ActivatedAbility> activatedAbilities) {
        this.basicManaAbilities.clear();
        this.basicPlayAbilities.clear();
        this.basicCastAbilities.clear();
        this.other.clear();

        // split abilities to types (it allows to enable or disable playable icon)
        for (ActivatedAbility ability : activatedAbilities) {
            List<PlayableObjectRecord> dest;
            if (ability instanceof BasicManaAbility) {
                dest = this.basicManaAbilities;
            } else if (ability instanceof PlayLandAbility) {
                dest = this.basicPlayAbilities;
            } else if (ability instanceof SpellAbility && (((SpellAbility) ability).getSpellAbilityType() == SpellAbilityType.BASE)) {
                dest = this.basicCastAbilities;
            } else {
                dest = this.other;
            }

            // collect info about abilities for card icons popup, must be simple online text (html symbols are possible)
            // some long html tags can be miss (example: ability extra hint) -- that's ok
            String shortInfo = ability.toString();
            shortInfo = shortInfo.replace("<br>", " ");
            shortInfo = shortInfo.replace("\n", " ");
            if (shortInfo.length() > 50) {
                shortInfo = shortInfo.substring(0, 50 - 1) + "...";
            }
            dest.add(new PlayableObjectRecord(ability, shortInfo));
        }
    }

    public static List<ManaType> fixedManaColors(Ability ability) {
        if (ability.getAbilityType() != AbilityType.ACTIVATED_MANA) {
            return null;
        }
        return ability.getEffects().stream()
                .filter(effect -> effect.getClass() == BasicManaEffect.class)
                .map(effect -> ((BasicManaEffect) effect).getManaTemplate())
                .flatMap(mana -> Arrays.stream(ManaType.values())
                        .filter(color -> color != ManaType.GENERIC && mana.get(color) > 0))
                .distinct().collect(Collectors.toList());
    }

    protected PlayableObjectStats(final PlayableObjectStats source) {
        for (PlayableObjectRecord rec : source.basicManaAbilities) {
            this.basicManaAbilities.add(rec.copy());
        }
        for (PlayableObjectRecord rec : source.basicPlayAbilities) {
            this.basicPlayAbilities.add(rec.copy());
        }
        for (PlayableObjectRecord rec : source.basicCastAbilities) {
            this.basicCastAbilities.add(rec.copy());
        }
        for (PlayableObjectRecord rec : source.other) {
            this.other.add(rec.copy());
        }
    }

    @Override
    public PlayableObjectStats copy() {
        return new PlayableObjectStats(this);
    }

    public int getPlayableAmount() {
        return this.basicManaAbilities.size()
                + this.basicPlayAbilities.size()
                + this.basicCastAbilities.size()
                + this.other.size();
    }

    public List<String> getPlayableAbilityNames() {
        List<String> all = new ArrayList<>();
        all.addAll(this.basicManaAbilities.stream().map(PlayableObjectRecord::getValue).sorted().collect(Collectors.toList()));
        all.addAll(this.basicPlayAbilities.stream().map(PlayableObjectRecord::getValue).sorted().collect(Collectors.toList()));
        all.addAll(this.basicCastAbilities.stream().map(PlayableObjectRecord::getValue).sorted().collect(Collectors.toList()));
        all.addAll(this.other.stream().map(PlayableObjectRecord::getValue).sorted().collect(Collectors.toList()));
        return all;
    }

    public List<UUID> getPlayableAbilityIds() {
        List<UUID> all = new ArrayList<>();
        all.addAll(this.basicManaAbilities.stream().map(PlayableObjectRecord::getId).collect(Collectors.toList()));
        all.addAll(this.basicPlayAbilities.stream().map(PlayableObjectRecord::getId).collect(Collectors.toList()));
        all.addAll(this.basicCastAbilities.stream().map(PlayableObjectRecord::getId).collect(Collectors.toList()));
        all.addAll(this.other.stream().map(PlayableObjectRecord::getId).collect(Collectors.toList()));
        return all;
    }

    public int getPlayableImportantAmount() {
        // return only important abilities (e.g. show it as card icons)
        return this.other.size();
    }
}

class PlayableObjectRecord implements Serializable, Copyable<PlayableObjectRecord> {

    // Preserve the serialization identity of reliable game recovery backups.
    private static final long serialVersionUID = 3742240574740107254L;
    final UUID id;
    final String value;
    final AbilityType abilityType;
    final List<ManaType> manaColors;
    final Boolean plainMana;

    public PlayableObjectRecord(ActivatedAbility ability, String value) {
        this.id = ability.getId();
        this.value = value;
        this.abilityType = ability.getAbilityType();
        this.manaColors = PlayableObjectStats.fixedManaColors(ability);
        this.plainMana = manaColors != null && !manaColors.isEmpty() && ability.getEffects().size() == 1
                && ability.getCosts().size() == 1 && ability.getCosts().get(0) instanceof TapSourceCost
                && ability.getManaCosts().isEmpty() && ability.getTargets().isEmpty();
    }


    private PlayableObjectRecord(final PlayableObjectRecord record) {
        this.id = record.id;
        this.value = record.value;
        this.abilityType = record.abilityType;
        this.manaColors = record.manaColors;
        this.plainMana = record.plainMana;
    }

    public UUID getId() {
        return id;
    }

    public String getValue() {
        return value;
    }

    @Override
    public PlayableObjectRecord copy() {
        return new PlayableObjectRecord(this);
    }
}
