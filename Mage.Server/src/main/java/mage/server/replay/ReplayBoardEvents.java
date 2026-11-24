package mage.server.replay;

import mage.view.GameEventView;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

final class ReplayBoardEvents {
    private ReplayBoardEvents() {}

    // The watcher feed blanks identities on private events. Retain only typed public outcomes
    // and resolve their names later against the spectator's visible board.
    static List<GameEventView> confirmed(List<GameEventView> events) {
        if (events.isEmpty()) return Collections.emptyList();
        List<GameEventView> result = new ArrayList<>();
        for (GameEventView event : events) {
            if (event.getTargetId() == null) continue;
            if (event.getKind() == GameEventView.GameEventKind.DAMAGE && event.getSourceId() != null && event.getAmount() > 0) {
                result.add(new GameEventView(event.getSeq(), event.getKind()).target(event.getTargetId(), null)
                        .source(event.getSourceId(), null).amount(event.getAmount()).combat(event.isCombat()));
            } else if (event.getKind() == GameEventView.GameEventKind.ZONE
                    && "BATTLEFIELD".equals(event.getFromZone()) && "EXILED".equals(event.getToZone())) {
                result.add(new GameEventView(event.getSeq(), event.getKind()).target(event.getTargetId(), null)
                        .zones("BATTLEFIELD", "EXILED"));
            }
        }
        return result;
    }
}
