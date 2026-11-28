package mage.abilities.common;

import mage.abilities.MageSingleton;
import mage.abilities.StaticAbility;
import mage.constants.AbilityType;
import mage.constants.Zone;

public final class CombatDamageByAbsolutePowerAbility extends StaticAbility implements MageSingleton {

    private static final CombatDamageByAbsolutePowerAbility INSTANCE = new CombatDamageByAbsolutePowerAbility();

    private CombatDamageByAbsolutePowerAbility() {
        super(AbilityType.STATIC, Zone.BATTLEFIELD);
    }

    public static CombatDamageByAbsolutePowerAbility getInstance() {
        return INSTANCE;
    }

    @Override
    public String getRule() {
        return "If {this}'s power is negative, it assigns combat damage as though its power were positive.";
    }

    @Override
    public CombatDamageByAbsolutePowerAbility copy() {
        return INSTANCE;
    }

    private Object readResolve() {
        return INSTANCE;
    }
}
