import { api, DEFAULT_SERVER_URL, rpc } from './connection';
import { useSession } from './stores/session';

export class SignInRequired extends Error {}
let connecting: Promise<void> | null = null;

/** The cookie authenticates the person; the proxy names the engine seat. Never use a remembered XMage name. */
export function connectPrivateSession(): Promise<void> {
  if (connecting) return connecting;
  connecting = (async () => {
    const response = await fetch('/api/playtesting/me', { credentials: 'same-origin', cache: 'no-store' });
    if (response.status === 401) throw new SignInRequired();
    if (!response.ok) throw new Error('private-connect');
    const identity = await response.json() as { engineName?: string; agent?: boolean };
    if (typeof identity.engineName !== 'string' || !identity.engineName || identity.agent) throw new Error('private-identity');
    if (rpc.getStatus() !== 'open' || rpc.getUrl() !== DEFAULT_SERVER_URL) await rpc.connect(DEFAULT_SERVER_URL);
    const info = await api.serverInfo();
    if (!info.signOn || info.signOn.toLowerCase() !== identity.engineName.toLowerCase()) throw new Error('private-identity');
    if (!await useSession.getState().signInWithSignOn(DEFAULT_SERVER_URL, info.signOn)) throw new Error('private-connect');
  })().finally(() => { connecting = null; });
  return connecting;
}
