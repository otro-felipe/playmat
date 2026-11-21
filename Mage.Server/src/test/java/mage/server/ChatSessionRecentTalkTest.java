package mage.server;

import java.lang.reflect.Proxy;
import java.util.Collections;
import java.util.List;
import java.util.UUID;
import mage.game.Game;
import mage.server.social.UserRelations;
import mage.view.ChatMessage;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class ChatSessionRecentTalkTest {
    private static ChatSession gameChat() {
        UUID id = UUID.randomUUID();
        Game game = (Game) Proxy.newProxyInstance(Game.class.getClassLoader(), new Class<?>[]{ Game.class },
                (proxy, method, args) -> method.getName().equals("getId") ? id : null);
        return new ChatSession(null, "fixture").withGame(game);
    }

    private static void emit(ChatSession chat, String who, String text, ChatMessage.MessageType type) {
        chat.broadcast(who, text, ChatMessage.MessageColor.BLUE, true, null, type, null);
    }

    @Test void reconnectReturnsOnlyBoundedPublicGameTalkWithItsOriginalSequence() {
        ChatSession chat = gameChat();
        for (int i = 1; i <= 52; i++) emit(chat, i == 51 ? "Ignored" : "Rival", "Message " + i, ChatMessage.MessageType.TALK);
        for (ChatMessage.MessageType kind : ChatMessage.MessageType.values()) {
            if (kind != ChatMessage.MessageType.TALK) emit(chat, "Rival", kind.name(), kind);
        }
        UUID member = UUID.randomUUID();
        assertTrue(chat.recentTalk(member).isEmpty());
        chat.getUsers().put(member, "Member");
        UserRelations.setIgnored(member, Collections.singletonList("iGnOrEd"));
        List<ChatMessage> replay = chat.recentTalk(member);
        assertEquals(49, replay.size());
        assertEquals(Long.valueOf(3), replay.get(0).getChatSequence());
        assertEquals(Long.valueOf(52), replay.get(48).getChatSequence());
        assertTrue(replay.stream().allMatch(row -> row.getMessageType() == ChatMessage.MessageType.TALK));
        assertEquals("Message 52", replay.get(48).getMessage());
        assertEquals(replay, chat.recentTalk(member));
        chat.getUsers().remove(member);
        assertTrue(chat.recentTalk(member).isEmpty());
        UserRelations.setIgnored(member, Collections.emptyList());
        ChatSession room = new ChatSession(null, "room").withRoom(UUID.randomUUID());
        emit(room, "Rival", "Room talk", ChatMessage.MessageType.TALK);
        room.getUsers().put(member, "Member");
        assertTrue(room.recentTalk(member).isEmpty());
    }
}
