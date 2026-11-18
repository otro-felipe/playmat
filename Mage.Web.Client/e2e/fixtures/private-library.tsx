import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { useSession } from '../../src/app/stores/session';
import { useSettings } from '../../src/app/stores/settings';
import { api, DEFAULT_SERVER_URL, rpc } from '../../src/app/connection';
import { PrivateSession } from '../../src/app/PrivateSession';
import { DecksScreen } from '../../src/app/screens/DecksScreen';
import { queryClient } from '../../src/app/queries';
import '../../src/app/stores/deckSync';
import '../../src/app/styles/base.css';

// Only the engine handshake is stubbed; the real private session, HTTP deck sync and deck screen run here.
const authCalls: { name: string; passwordProvided: boolean }[] = [];
rpc.getStatus = () => 'open';
rpc.getUrl = () => DEFAULT_SERVER_URL;
rpc.connect = async () => {};
api.serverInfo = async () => ({ signOn: 'Alice', deckSync: true, accounts: false });
api.connectUser = async (name, password) => { authCalls.push({ name, passwordProvided: !!password }); return true; };
api.sessionUserName = async () => 'Alice';
api.sessionGetRestoreToken = async () => '';
api.serverGetMainRoomId = async () => 'fixture-room';
useSettings.getState().update({ locale: 'es', sound: false, animations: false });
queryClient.setQueryData(['serverInfo'], { signOn: 'Alice', deckSync: true, accounts: false });
Object.assign(window, { privateLibraryFixture: { authCalls } });

export function Fixture() {
  const phase = useSession((state) => state.phase);
  return <QueryClientProvider client={queryClient}><MemoryRouter initialEntries={['/decks']}>
    {phase === 'signedIn' ? <div style={{ padding: 16, maxWidth: 1200, height: '100dvh', marginInline: 'auto' }}><DecksScreen /></div> : <PrivateSession />}
  </MemoryRouter></QueryClientProvider>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
