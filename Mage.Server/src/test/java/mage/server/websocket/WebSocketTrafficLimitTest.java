package mage.server.websocket;

import org.junit.Test;

import java.util.concurrent.atomic.AtomicLong;

import static org.assertj.core.api.Assertions.assertThat;

public class WebSocketTrafficLimitTest {
    @Test
    public void heavyCallsShareAnAccountBudgetAcrossMethodsAndAnInstanceBudgetAcrossAccounts() {
        AtomicLong clock = new AtomicLong();
        WebSocketTrafficLimit limit = new WebSocketTrafficLimit(clock::get, 2, 3);
        assertThat(limit.allow("alice", "roomCreateTable")).isTrue();
        assertThat(limit.allow("alice", "matchStart")).isTrue();
        assertThat(limit.allow("alice", "soloResume")).isFalse();
        assertThat(limit.allow("alice", "sendPlayerBoolean")).isTrue();
        assertThat(limit.allow("bob", "gamePractice")).isTrue();
        assertThat(limit.allow("charlie", "soloFork")).isFalse();
        clock.set(60_000_000_000L);
        assertThat(limit.allow("alice", "soloFork")).isTrue();
    }
}
