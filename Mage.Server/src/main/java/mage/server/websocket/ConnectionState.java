package mage.server.websocket;

import mage.server.websocket.rpc.RpcConnection;
import org.java_websocket.WebSocket;
import mage.server.ClientChannel;

import java.util.ArrayDeque;
import java.util.Collections;
import java.util.List;
import java.util.Queue;
import java.util.UUID;
import java.util.concurrent.Executor;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Web client bridge: per-connection state (bound session, request queue, rate limit).
 * <p>
 * Requests of one connection run one at a time and in order on the shared worker pool,
 * so slow requests never block the socket threads or other players.
 */
final class ConnectionState implements RpcConnection {

    // token bucket: sustained requests per second and burst size
    private static final double RATE_PER_SECOND = 40.0;
    private static final double BURST = 120.0;
    private static final int MAX_PENDING_REQUESTS = 128;

    private final WebSocket conn;
    private final String remoteHost;
    private final Executor workers;
    private final long maxOutgoingBytes;
    private final AtomicBoolean holdsConnectionSlot = new AtomicBoolean();
    private final Queue<Runnable> queue = new ArrayDeque<>();
    private boolean running;

    private volatile String sessionId;
    private volatile String userName;
    /** set once, from the handshake, before the connection's first request */
    private volatile String signedOnUser;
    private mage.server.recovery.RecoveryPrincipal recoveryPrincipal;
    private boolean canonicalAgent;
    private volatile HumanTableScope humanScope;
    private volatile HumanSeatChannel humanChannel;

    void setHumanScope(HumanTableScope scope) { humanScope = scope; }
    HumanTableScope humanScope() { return humanScope; }
    @Override public String getHumanTable() { return humanScope == null ? null : humanScope.header(); }

    void attach(HumanSeatChannel group) {
        humanChannel = group;
        makeHandler();
    }
    HumanSeatChannel humanChannel() { return humanChannel; }
    void detach() { humanChannel = null; }
    boolean isOpen() { return conn.isOpen(); }
    void replaced() { conn.close(WebSocketServerImpl.CLOSE_SIGNED_IN_ELSEWHERE, "Signed in somewhere else"); }
    boolean browserHostsGames() { return gameHost; }
    String browserHostId() { return gameHostId; }

    boolean deliver(mage.interfaces.callback.ClientCallback event) throws ClientChannel.Closed {
        if (humanScope == null) {
            callbackHandler.send(event);
        } else {
            if (!humanScope.accept(event)) return false;
            callbackHandler.sendSeatView(event);
        }
        return true;
    }

    @Override public boolean rejoinSharedGame(UUID gameId) {
        return humanChannel != null && humanScope == null && humanChannel.rejoinBrowser(this, gameId);
    }

    void forgetLocalPrompt(UUID gameId) {
        WebSocketCallbackHandler handler = callbackHandler;
        if (handler != null) handler.promptAnswered(gameId);
    }
    private volatile WebSocketCallbackHandler callbackHandler;
    private final GameStates gameStates = new GameStates();
    /** one per connection, shared by its logins' handlers, so its messages keep their order */
    private final Executor sender = SerialSender.create();

    private int rateLimitStrikes;
    private double tokens = BURST;
    private long lastRefillNanos = System.nanoTime();

    /**
     * @param remoteHost       client IP (behind a trusted proxy: the forwarded one, see {@link ClientAddressResolver})
     * @param maxOutgoingBytes bytes queued for this client before the connection is dropped
     */
    ConnectionState(WebSocket conn, Executor workers, String remoteHost, long maxOutgoingBytes) {
        this.conn = conn;
        this.workers = workers;
        this.remoteHost = remoteHost == null ? "" : remoteHost;
        this.maxOutgoingBytes = maxOutgoingBytes;
    }

    long getMaxOutgoingBytes() {
        return maxOutgoingBytes;
    }

    void markConnectionSlotHeld() {
        holdsConnectionSlot.set(true);
    }

    /**
     * @return true exactly once if this connection held a per-IP connection slot
     */
    boolean releaseConnectionSlot() {
        return holdsConnectionSlot.compareAndSet(true, false);
    }

    @Override
    public String getSessionId() {
        return sessionId;
    }

    @Override
    public void bindSession(String sessionId) {
        this.sessionId = sessionId;
    }

    @Override
    public String getUserName() {
        return userName;
    }

    @Override
    public void setUserName(String userName) {
        this.userName = userName;
    }

    @Override
    public String getSignedOnUser() {
        return signedOnUser;
    }

    void setSignedOnUser(String signedOnUser) {
        this.signedOnUser = signedOnUser;
    }

    @Override public boolean isCanonicalAgent() { return canonicalAgent; }
    void setCanonicalAgent(boolean canonicalAgent) { this.canonicalAgent = canonicalAgent; }

    @Override public mage.server.recovery.RecoveryPrincipal getRecoveryPrincipal() { return recoveryPrincipal; }
    void setRecoveryPrincipal(mage.server.recovery.RecoveryPrincipal principal) { recoveryPrincipal = principal; }

    @Override
    public String getRemoteHost() {
        return remoteHost;
    }

    @Override
    public ClientChannel createChannel() {
        return humanChannel != null ? humanChannel : makeHandler();
    }

    private WebSocketCallbackHandler makeHandler() {
        synchronized (gameStates) {
            gameStates.newSession();
        }
        WebSocketCallbackHandler handler = new WebSocketCallbackHandler(conn, gameStates, sender);
        handler.setHostsGames(() -> gameHost);
        handler.setGameHostId(() -> gameHost ? gameHostId : null);
        callbackHandler = handler;
        return handler;
    }

    @Override
    public List<String> setCapabilities(List<String> requested) {
        boolean stateDiffs = requested.contains(GameStates.CAPABILITY);
        synchronized (gameStates) {
            gameStates.setEnabled(stateDiffs);
        }
        // the gateway hosts games (docs/rust/GameHost.md): believed only from a trusted proxy's address
        gameHost = humanScope == null && requested.contains(GAME_HOST) && trustedPeer;
        // and the gateway's own id, so the two players of a game between people can be found on one gateway
        gameHostId = null;
        for (String c : requested) {
            if (gameHost && c != null && c.startsWith(GAME_HOST + ":") && c.length() > GAME_HOST.length() + 1) {
                gameHostId = c.substring(GAME_HOST.length() + 1);
            }
        }
        List<String> granted = new java.util.ArrayList<>();
        if (stateDiffs) {
            granted.add(GameStates.CAPABILITY);
        }
        if (gameHost) {
            granted.add(GAME_HOST);
        }
        return granted;
    }

    /** the capability of a gateway that plays games on the Rust host */
    static final String GAME_HOST = "gameHost";
    private volatile boolean gameHost;
    private volatile String gameHostId;
    /** the connection comes from a trusted proxy (the gateway), whose capabilities are believed */
    private volatile boolean trustedPeer;

    void setTrustedPeer(boolean trusted) {
        this.trustedPeer = trusted;
    }

    @Override
    public boolean resendGameState(UUID gameId) {
        WebSocketCallbackHandler handler = callbackHandler;
        return handler != null && handler.resendState(gameId);
    }

    @Override
    public void forgetGameState(UUID gameId) {
        synchronized (gameStates) {
            gameStates.forget(gameId);
        }
    }

    /**
     * The socket closed: game states are no longer needed.
     */
    void closed() {
        synchronized (gameStates) {
            gameStates.newSession();
        }
    }

    @Override
    public void promptAnswered(UUID gameId) {
        if (humanChannel != null) humanChannel.answered(gameId);
        else forgetLocalPrompt(gameId);
    }

    @Override
    public boolean takeCurrentPrompt(UUID gameId) {
        if (humanChannel != null) return humanChannel.takeCurrentPrompt(gameId);
        return RpcConnection.super.takeCurrentPrompt(gameId);
    }

    @Override
    public boolean takePrompt(UUID gameId, int messageId) {
        if (humanChannel != null) return humanChannel.takePrompt(gameId, messageId);
        WebSocketCallbackHandler handler = callbackHandler;
        return handler != null && handler.takePrompt(gameId, messageId);
    }

    @Override
    public boolean resendPrompt(UUID gameId) {
        if (humanChannel != null) return humanChannel.resendPrompt(this, gameId);
        WebSocketCallbackHandler handler = callbackHandler;
        return handler != null && handler.resendPrompt(gameId);
    }

    synchronized boolean tryAcquire() {
        long now = System.nanoTime();
        tokens = Math.min(BURST, tokens + (now - lastRefillNanos) / 1_000_000_000.0 * RATE_PER_SECOND);
        lastRefillNanos = now;
        if (tokens < 1.0) {
            return false;
        }
        tokens -= 1.0;
        return true;
    }

    synchronized int recordRateLimitStrike() {
        return ++rateLimitStrikes;
    }

    /**
     * Runs the task after every earlier task of this connection has finished.
     *
     * @throws java.util.concurrent.RejectedExecutionException when the worker pool is saturated
     */
    void submit(Runnable task) {
        enqueue(task, false);
    }

    void submitCleanup(Runnable task) {
        enqueue(task, true);
    }

    private void enqueue(Runnable task, boolean cleanup) {
        synchronized (queue) {
            if (!cleanup && queue.size() >= MAX_PENDING_REQUESTS) {
                throw new RejectedExecutionException("Too many pending WebSocket requests");
            }
            queue.add(task);
            if (running) {
                return;
            }
            running = true;
            try {
                workers.execute(this::drain);
            } catch (RuntimeException e) {
                queue.remove(task);
                running = false;
                throw e;
            }
        }
    }

    private void drain() {
        while (true) {
            Runnable next;
            synchronized (queue) {
                next = queue.poll();
                if (next == null) {
                    running = false;
                    return;
                }
            }
            next.run();
        }
    }
}
