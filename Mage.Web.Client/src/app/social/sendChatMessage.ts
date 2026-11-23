import { api } from '../connection';
import { useSession } from '../stores/session';
import { chatBodyTooLong } from '../../core/social/chatInput';

export async function sendChatMessage(chatId: string | null, text: string) {
  if (!text.trim()) return;
  if (chatBodyTooLong(text)) throw new RangeError('Chat message exceeds the limit');
  if (!chatId) throw new Error('Chat is unavailable');
  const sent = await api.chatSendMessage(chatId, useSession.getState().userName, text);
  if (sent === false) throw new Error('Chat send failed');
}
