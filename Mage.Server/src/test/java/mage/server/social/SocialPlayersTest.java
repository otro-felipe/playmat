package mage.server.social;

import mage.view.RoomUsersView;
import mage.view.UsersView;
import org.junit.jupiter.api.Test;

import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import java.util.Set;
import java.util.stream.Collectors;

import static org.assertj.core.api.Assertions.assertThat;

class SocialPlayersTest {
    private static UsersView user(String name) {
        return new UsersView("world.png", name, "", 0, "", 0, "", "", 0, 0, 0);
    }

    @Test
    void filtersOnlyRegisteredAgentIdentitiesAndKeepsOriginalObjectsAndGameCounts() {
        UsersView human = user("mcp_abcdef1234");
        UsersView rival = user("LegacyRival");
        List<RoomUsersView> original = Collections.singletonList(new RoomUsersView(
                Arrays.asList(user("Felipe"), human, rival, user("MCP_1234567890")), 3, 4, 5));
        Set<String> agents = new java.util.HashSet<>(Arrays.asList("legacyrival", "mcp_1234567890"));
        RoomUsersView shown = SocialPlayers.withoutAgents(original, agents).get(0);
        assertThat(shown.getUsersView().stream().map(UsersView::getUserName).collect(Collectors.toList()))
                .containsExactly("Felipe", "mcp_abcdef1234");
        assertThat(shown.getUsersView().get(1)).isSameAs(human);
        assertThat(shown.getNumberActiveGames()).isEqualTo(3);
        assertThat(shown.getNumberGameThreads()).isEqualTo(4);
        assertThat(shown.getNumberMaxGames()).isEqualTo(5);
        assertThat(original.get(0).getUsersView()).as("not a mutation of users, profiles or game participants").contains(rival);
        assertThat(SocialPlayers.withoutAgents(original, Collections.emptySet())).isSameAs(original);
    }
}
