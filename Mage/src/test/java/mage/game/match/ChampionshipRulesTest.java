package mage.game.match;

import java.util.UUID;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

public class ChampionshipRulesTest {
    @Test
    public void timedRoundFinishesCurrentTurnAndFiveMoreIncludingExtraTurns() {
        ChampionshipRules rules = new ChampionshipRules(UUID.randomUUID(), "a", "b", false, 1, 100);
        assertFalse(rules.finishedTurn(99, 8));
        assertFalse(rules.finishedTurn(100, 9));
        for (int turn = 10; turn < 14; turn++) assertFalse(rules.finishedTurn(110, turn));
        assertTrue(rules.finishedTurn(110, 14));
    }
    @Test
    public void worldPlayoffHasTwoPreboardGamesAndNoDeadline() {
        ChampionshipRules rules = new ChampionshipRules(UUID.randomUUID(), "a", "b", true, 2, 0);
        assertFalse(rules.allowsSideboard(1));
        assertTrue(rules.allowsSideboard(2));
        assertFalse(rules.finishedTurn(Long.MAX_VALUE, 99));
    }
    @Test
    public void tiedPlayoffEntersSuddenDeathAtTimeInGameOrBetweenGames() {
        ChampionshipRules rules = new ChampionshipRules(UUID.randomUUID(), "a", "b", true, 1, 100);
        assertFalse(rules.useLifeAtEndOfExtraTurns(), "Unequal game wins finish the current game as a draw.");
        rules.gamesTiedOnEntry = true;
        assertTrue(rules.useLifeAtEndOfExtraTurns());
        assertTrue(rules.usesLifeTiebreaker());
        ChampionshipRules between = new ChampionshipRules(UUID.randomUUID(), "a", "b", true, 1, 100);
        between.tiedBetweenGames();
        assertTrue(between.usesLifeTiebreaker());
    }
}
