package mage.server.game;

import mage.game.match.MatchOptions;

/** Operator-controlled private-match policy. It never changes the ordinary public/ranked timeout. */
final class PrivateMatchIdlePolicy {
    static final long DEFAULT_SECONDS = 15 * 60;

    private PrivateMatchIdlePolicy() { }

    static boolean eligible(MatchOptions options, boolean tournament, boolean tournamentSubtable,
                            int players, int humanPlayers, int seatedUsers) {
        return options != null && !tournament && !tournamentSubtable && !options.isRated()
                && !options.isSpectatorsAllowed() && players == 2 && humanPlayers == 2 && seatedUsers == 2;
    }

    static long seconds(boolean productGateway, boolean privateUnratedTwoHumans,
                        boolean distinctAuthenticatedParticipants, long ordinarySeconds, String configured) {
        if (!productGateway || !privateUnratedTwoHumans || !distinctAuthenticatedParticipants) return ordinarySeconds;
        if (configured == null || configured.trim().isEmpty()) return DEFAULT_SECONDS;
        try {
            long seconds = Long.parseLong(configured);
            return seconds >= 60 && seconds <= 3600 ? seconds : DEFAULT_SECONDS;
        } catch (NumberFormatException invalid) {
            return DEFAULT_SECONDS;
        }
    }
}
