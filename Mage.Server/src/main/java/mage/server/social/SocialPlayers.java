package mage.server.social;

import mage.view.RoomUsersView;
import mage.view.UsersView;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.stream.Collectors;

/** Human social discovery only. Game seats, aliases, profiles, history and account records remain untouched. */
public final class SocialPlayers {
    private SocialPlayers() { }

    public static boolean human(String name, Set<String> agents) {
        return name == null || !agents.contains(name.toLowerCase(Locale.ROOT));
    }

    public static List<RoomUsersView> withoutAgents(List<RoomUsersView> rooms, Set<String> agents) {
        if (rooms == null || agents.isEmpty()) return rooms;
        List<RoomUsersView> shown = new ArrayList<>(rooms.size());
        for (RoomUsersView room : rooms) {
            List<UsersView> people = room.getUsersView().stream()
                    .filter(user -> human(user.getUserName(), agents)).collect(Collectors.toList());
            shown.add(new RoomUsersView(people, room.getNumberActiveGames(), room.getNumberGameThreads(), room.getNumberMaxGames()));
        }
        return shown;
    }
}
