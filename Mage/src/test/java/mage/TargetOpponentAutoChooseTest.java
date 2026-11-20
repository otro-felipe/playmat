package mage;

import mage.abilities.Ability;
import mage.abilities.common.SimpleActivatedAbility;
import mage.abilities.costs.mana.ManaCostsImpl;
import mage.abilities.effects.common.DrawCardSourceControllerEffect;
import mage.abilities.effects.common.search.SearchLibraryPutInPlayTargetPlayerEffect;
import mage.constants.RangeOfInfluence;
import mage.game.FakeGame;
import mage.players.StubPlayer;
import mage.players.net.UserData;
import mage.target.TargetPlayer;
import mage.target.common.TargetCardInLibrary;
import mage.target.common.TargetOpponent;
import org.junit.Before;
import org.junit.Test;

import static java.util.Arrays.asList;
import static java.util.Collections.emptyList;
import static java.util.Collections.singletonList;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

public class TargetOpponentAutoChooseTest {

    private final FakeGame game = new FakeGame();
    private final StubPlayer pilot = new StubPlayer("Pilot", RangeOfInfluence.ALL) {
        @Override
        public boolean isHuman() {
            return true;
        }
    };
    private final StubPlayer opponent = new StubPlayer("Opponent", RangeOfInfluence.ALL);
    private final TargetOpponent target = new TargetOpponent();
    private final Ability source = new SimpleActivatedAbility(new DrawCardSourceControllerEffect(1), new ManaCostsImpl<>("{0}"));

    @Before
    public void setUp() {
        game.getState().addPlayer(pilot);
        game.getState().addPlayer(opponent);
        pilot.updateRange(game);
        pilot.setUserData(UserData.getDefaultUserDataView());
        pilot.getUserData().setAutoTargetLevel(1);
        source.setControllerId(pilot.getId());
    }

    @Test
    public void standardAutoTargetSelectsTheOnlyLegalOpponent() {
        assertEquals(opponent.getId(), target.tryToAutoChoose(pilot.getId(), source, game, singletonList(opponent.getId())));
        assertNull(target.tryToAutoChoose(pilot.getId(), source, game, singletonList(pilot.getId())));
    }

    @Test
    public void forcedOpponentCanBeNamedBeforeALaterSearch() {
        Ability search = new SimpleActivatedAbility(
                new SearchLibraryPutInPlayTargetPlayerEffect(new TargetCardInLibrary(), false), new ManaCostsImpl<>("{0}"));
        search.setControllerId(pilot.getId());
        assertEquals(opponent.getId(), target.tryToAutoChoose(pilot.getId(), search, game, singletonList(opponent.getId())));
        assertNull(new TargetPlayer().tryToAutoChoose(pilot.getId(), search, game, singletonList(pilot.getId())));
    }

    @Test
    public void preservesManualChoicesAndTheAutoTargetSetting() {
        assertNull(target.tryToAutoChoose(pilot.getId(), source, game, emptyList()));
        StubPlayer otherOpponent = new StubPlayer("Other opponent", RangeOfInfluence.ALL);
        game.getState().addPlayer(otherOpponent);
        pilot.updateRange(game);
        assertNull(target.tryToAutoChoose(pilot.getId(), source, game, asList(opponent.getId(), otherOpponent.getId())));
        assertNull(new TargetPlayer().tryToAutoChoose(pilot.getId(), source, game, singletonList(opponent.getId())));
        assertNull(new TargetOpponent(0, 1, false).tryToAutoChoose(pilot.getId(), source, game, singletonList(opponent.getId())));
        pilot.getUserData().setAutoTargetLevel(0);
        assertNull(target.tryToAutoChoose(pilot.getId(), source, game, singletonList(opponent.getId())));
    }
}
