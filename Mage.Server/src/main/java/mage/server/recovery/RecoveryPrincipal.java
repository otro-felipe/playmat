package mage.server.recovery;

import java.io.Serializable;
import java.util.Objects;
import java.util.UUID;

/** Immutable product principal. Set only from a trusted, authenticated WebSocket handshake. */
public final class RecoveryPrincipal implements Serializable {
    private static final long serialVersionUID = 1L;
    public final UUID accountId;
    public final String seatId;
    public final UUID connectionId;

    public RecoveryPrincipal(UUID accountId, String seatId) {
        this(accountId,seatId,null);
    }

    public RecoveryPrincipal(UUID accountId, String seatId, UUID connectionId) {
        if (accountId == null || seatId == null || !seatId.matches("(human|agent):[a-fA-F0-9-]{36}")) {
            throw new IllegalArgumentException("Invalid recovery principal");
        }
        UUID seat = UUID.fromString(seatId.substring(seatId.indexOf(':') + 1));
        if (seatId.startsWith("human:") && !accountId.equals(seat)) throw new IllegalArgumentException("Invalid human seat");
        this.accountId = accountId;
        this.seatId = seatId.toLowerCase(java.util.Locale.ROOT);
        this.connectionId = connectionId;
    }

    @Override public boolean equals(Object other) {
        return other instanceof RecoveryPrincipal && accountId.equals(((RecoveryPrincipal) other).accountId)
                && seatId.equals(((RecoveryPrincipal) other).seatId);
    }
    @Override public int hashCode() { return Objects.hash(accountId, seatId); }
}
