package mage.server;

import com.google.common.util.concurrent.MoreExecutors;
import java.lang.reflect.InvocationHandler;
import java.lang.reflect.Proxy;
import java.util.Collections;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import mage.MageException;
import mage.constants.Constants;
import mage.game.Game;
import mage.server.managers.ManagerFactory;
import mage.server.managers.ThreadExecutor;
import mage.server.managers.UserManager;
import org.junit.jupiter.api.Test;
import org.unbescape.html.HtmlEscape;
import static org.junit.jupiter.api.Assertions.*;

class ChatMessageDeliveryTest {
    private static <T> T stub(Class<T> type, InvocationHandler handler) {
        return type.cast(Proxy.newProxyInstance(type.getClassLoader(), new Class<?>[]{type}, handler));
    }

    private final User sender = new User(null, "Fixture sender", "", null);
    private final UserManager users = stub(UserManager.class, (p,m,a) -> Optional.of(sender));
    private final ExecutorService immediate = MoreExecutors.newDirectExecutorService();
    private final ThreadExecutor executor = stub(ThreadExecutor.class, (p,m,a) -> immediate);
    private final ManagerFactory managers = stub(ManagerFactory.class, (p,m,a) -> {
        switch (m.getName()) {
            case "userManager": return users;
            case "threadExecutor": return executor;
            case "chatManager": return chat();
            default: throw new AssertionError(m.getName());
        }
    });
    private final ChatManagerImpl chat = new ChatManagerImpl(managers);
    private ChatManagerImpl chat() { return chat; }
    private final MageServerImpl server = new MageServerImpl(managers, "", true, false);
    private final UUID gameId = UUID.randomUUID();
    private final UUID chatId = chat.createGameChatSession(stub(Game.class, (p,m,a) -> gameId));

    @Test void anAcceptedMessageKeepsItsEntireEscapedBodyAcrossReconnects() throws MageException {
        String text = String.join("", Collections.nCopies(100, "&<")) + "\n🦦 &amp; fin";
        text += String.join("", Collections.nCopies(Constants.MAX_CHAT_MESSAGE_SIZE - text.codePointCount(0, text.length()), "á"));
        assertEquals(Constants.MAX_CHAT_MESSAGE_SIZE, text.codePointCount(0, text.length()));
        server.chatSendMessage(chatId, sender.getName(), text);
        ChatSession session = chat.getChatSessions().get(0);
        session.getUsers().put(sender.getId(), sender.getName());
        assertEquals(HtmlEscape.escapeHtml4(text), session.recentTalk(sender.getId()).get(0).getMessage());
    }

    @Test void anOversizeMessageReturnsAnErrorBeforeBroadcast() {
        String text = String.join("", Collections.nCopies(Constants.MAX_CHAT_MESSAGE_SIZE + 1, "a"));
        assertThrows(MageException.class, () -> server.chatSendMessage(chatId, sender.getName(), text));
        ChatSession session = chat.getChatSessions().get(0);
        session.getUsers().put(sender.getId(), sender.getName());
        assertTrue(session.recentTalk(sender.getId()).isEmpty());
    }
}
