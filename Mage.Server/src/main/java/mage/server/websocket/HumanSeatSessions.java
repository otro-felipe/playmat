package mage.server.websocket;

import com.google.gson.JsonArray;
import mage.server.recovery.RecoveryPrincipal;
import mage.server.websocket.rpc.RpcDispatcher;
import mage.server.websocket.rpc.RpcException;
import mage.server.websocket.rpc.RpcSessions;

import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/** A scoped transport can share only a successfully authenticated SSO login of the same product principal. */
final class HumanSeatSessions {
    private final Map<RecoveryPrincipal, HumanSeatChannel> active = new ConcurrentHashMap<>();
    private final Object[] locks = new Object[64];
    private final RpcSessions sessions;

    HumanSeatSessions(RpcSessions sessions) {
        this.sessions = sessions;
        for (int i = 0; i < locks.length; i++) locks[i] = new Object();
    }

    private Object lock(RecoveryPrincipal principal) { return locks[Math.floorMod(principal.hashCode(), locks.length)]; }

    boolean applies(ConnectionState state) {
        RecoveryPrincipal principal = state.getRecoveryPrincipal();
        return state.getSignedOnUser() != null && principal != null && principal.seatId.equals("human:" + principal.accountId);
    }

    Object login(ConnectionState state, JsonArray params, RpcDispatcher dispatcher) throws Exception {
        String signedOn = state.getSignedOnUser();
        if (params.isEmpty() || !params.get(0).isJsonPrimitive() || !signedOn.equalsIgnoreCase(params.get(0).getAsString())) {
            throw RpcException.notAuthorized("Use the authenticated human seat");
        }
        RecoveryPrincipal principal = state.getRecoveryPrincipal();
        synchronized (lock(principal)) {
            HumanSeatChannel group = active.get(principal);
            if (group != null && sessions.exists(group.sessionId) && signedOn.equalsIgnoreCase(group.name)
                    && (state.humanScope() != null || group.hasDelegate())) {
                if (state.humanChannel() != group) group.attach(state);
                state.bindSession(group.sessionId);
                state.setUserName(group.name);
                if (state.humanScope() == null) group.replaceBrowser(state);
                group.replay(state);
                return true;
            }
            // An ordinary browser-only re-login retains native takeover and token invalidation.
            if (state.humanChannel() != null) state.humanChannel().detach(state);
            group = new HumanSeatChannel(signedOn);
            group.attach(state);
            boolean accepted = false;
            try {
                Object result = dispatcher.dispatch("connectUser", params, state);
                accepted = Boolean.TRUE.equals(result) && state.getUserName() != null;
                if (accepted) {
                    group.sessionId = state.getSessionId();
                    active.put(principal, group);
                }
                return result;
            } finally {
                if (!accepted) {
                    group.detach(state);
                    state.detach();
                }
            }
        }
    }

    /** Returns true when another socket owns the live session and disconnecting it would interrupt play. */
    boolean leave(ConnectionState state) {
        HumanSeatChannel group = state.humanChannel();
        if (group == null) return false;
        RecoveryPrincipal principal = state.getRecoveryPrincipal();
        synchronized (lock(principal)) {
            boolean last = group.detach(state);
            state.detach();
            if (last) active.remove(principal, group);
            if (!last) state.bindSession(null);
            return !last;
        }
    }
}
