import { useRef, useState, type KeyboardEvent } from 'react';
import { chatBodyTooLong } from '../../core/social/chatInput';
import { useT } from '../i18n';

export function submitOnEnter(event: KeyboardEvent<HTMLTextAreaElement>) {
  if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
  }
}

export function useChatSubmit() {
  const t = useT();
  const sending = useRef(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<'chat.tooLong' | 'chat.sendFailed' | null>(null);
  async function submit(text: string, send: (value: string) => Promise<void> | void) {
    if (sending.current || !text.trim()) return false;
    if (chatBodyTooLong(text)) { setError('chat.tooLong'); return false; }
    sending.current = true;
    setPending(true);
    setError(null);
    try { await send(text); return true; }
    catch { setError('chat.sendFailed'); return false; }
    finally { sending.current = false; setPending(false); }
  }
  return { pending, error: error && t(error), clearError: () => setError(null), submit };
}
