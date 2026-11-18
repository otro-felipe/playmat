package mage.server.game;

import org.junit.jupiter.api.Test;
import mage.game.match.MatchOptions;
import static org.junit.jupiter.api.Assertions.*;

class PrivateMatchIdlePolicyTest {
    /** PM-AC-08-TIMING: ten minutes is a possible effective policy, not the private default. */
    @Test void ordinaryTenMinutePolicyAndExplicitPrivateOverrideRemainDistinct() {
        assertEquals(900, PrivateMatchIdlePolicy.seconds(true, true, true, 600, null));
        assertEquals(600, PrivateMatchIdlePolicy.seconds(true, true, true, 600, "600"));
        assertEquals(600, PrivateMatchIdlePolicy.seconds(true, false, true, 600, "900"));
        assertEquals(600, PrivateMatchIdlePolicy.seconds(true, true, false, 600, "900"));
        assertEquals(600, PrivateMatchIdlePolicy.seconds(false, true, true, 600, "900"));
    }
    @Test void realMatchOptionsKeepRankedSpectatedTournamentAndNonHumanModesOut() {
        MatchOptions options = new MatchOptions("Private idle policy fixture", "Two Player Duel", false);
        options.setRated(false);
        options.setSpectatorsAllowed(false);
        assertTrue(PrivateMatchIdlePolicy.eligible(options, false, false, 2, 2, 2));
        options.setRated(true);
        assertFalse(PrivateMatchIdlePolicy.eligible(options, false, false, 2, 2, 2));
        options.setRated(false);
        options.setSpectatorsAllowed(true);
        assertFalse(PrivateMatchIdlePolicy.eligible(options, false, false, 2, 2, 2));
        options.setSpectatorsAllowed(false);
        assertFalse(PrivateMatchIdlePolicy.eligible(options, true, false, 2, 2, 2));
        assertFalse(PrivateMatchIdlePolicy.eligible(options, false, true, 2, 2, 2));
        assertFalse(PrivateMatchIdlePolicy.eligible(options, false, false, 3, 3, 3));
        assertFalse(PrivateMatchIdlePolicy.eligible(options, false, false, 2, 1, 2));
        assertFalse(PrivateMatchIdlePolicy.eligible(options, false, false, 2, 2, 1));
        assertFalse(PrivateMatchIdlePolicy.eligible(null, false, false, 2, 2, 2));
    }

    @Test void onlyPrivateAuthenticatedTwoHumanMatchesUseTheGenerousPolicy() {
        assertEquals(900, PrivateMatchIdlePolicy.seconds(true, true, true, 120, null));
        assertEquals(900, PrivateMatchIdlePolicy.seconds(true, true, true, 120, ""));
        assertEquals(120, PrivateMatchIdlePolicy.seconds(false, true, true, 120, "1800"));
        assertEquals(120, PrivateMatchIdlePolicy.seconds(true, false, true, 120, "1800"));
        assertEquals(120, PrivateMatchIdlePolicy.seconds(true, true, false, 120, "1800"));
    }

    @Test void operatorBoundsFailToThePrivateDefaultWithoutAffectingOrdinaryGames() {
        assertEquals(60, PrivateMatchIdlePolicy.seconds(true, true, true, 120, "60"));
        assertEquals(3600, PrivateMatchIdlePolicy.seconds(true, true, true, 120, "3600"));
        for (String invalid : new String[]{"0", "59", "3601", "-1", "not-a-duration", "999999999999999999999"}) {
            assertEquals(900, PrivateMatchIdlePolicy.seconds(true, true, true, 120, invalid));
            assertEquals(120, PrivateMatchIdlePolicy.seconds(true, false, true, 120, invalid));
        }
    }
}
