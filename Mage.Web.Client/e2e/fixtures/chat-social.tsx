import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { useStore } from 'zustand';
import { GameSession } from '../../src/core/game/gameSession';
import type { ChatMessage, UsersView } from '../../src/protocol/generated/views';
import { api, events } from '../../src/app/connection';
import { queryClient } from '../../src/app/queries';
import { MatchStage } from '../../src/app/match/MatchStage';
import { useMatchUi } from '../../src/app/match/matchUi';
import { LobbyButton } from '../../src/app/social/LobbyButton';
import { LobbyDrawer } from '../../src/app/social/LobbyDrawer';
import { ProfileDialog } from '../../src/app/social/ProfileDialog';
import { useSession } from '../../src/app/stores/session';
import { useLobby } from '../../src/app/stores/lobby';
import { useSettings } from '../../src/app/stores/settings';
import '../../src/app/styles/base.css';

// Browser fixture only: social responses model SocialPlayers/PlayerDirectory's server-side projection.
// Product and Java tests exercise authoritative classification; the original match seat is retained here.
const surface = new URLSearchParams(location.search).get('surface') ?? 'chat';
const agent = 'mcp_1234567890';
const users: UsersView[] = [{ userName: 'Felipe', avatarId: 10, status: 'online' }, { userName: 'Bob', avatarId: 12, status: 'looking', generalRating: 1600 }];
const bodies = [
  '&#x41;hora s&iacute;, revancha sin regalar turnos 😈 Suerte, Felipe.',
  'La nutria ya lleg&oacute; a la oficina. Hoy s&iacute; 😄',
  'El &uacute;nico objetivo tambi&eacute;n deja sin resolver Learn.',
  '3/3 con 2 da&ntilde;os. Ese +1/+1 extra s&iacute; importa.',
  'Unicode directo: ÁÉÍÓÚ ü ñ 🦝',
  'Literal: &amp;iacute; [abc] {G}',
  '&lt;img src=x onerror=window.hostileExecuted=true&gt;',
];
const messages: ChatMessage[] = bodies.map((message, index) => ({ username: agent, message, messageType: 'TALK', time: 1_800_000_000_000 + index }));
Object.assign(window, { hostileExecuted: false });
api.chatFindByGame = async () => 'game-chat';
api.chatJoin = async (id) => {
  if (id === 'game-chat') setTimeout(() => messages.forEach((data, index) => events.dispatch({ method: 'CHATMESSAGE', objectId: id, messageId: index + 10, data })), 50);
  return true;
};
api.chatLeave = async () => true;
api.sendPlayerAction = async () => true;
api.roomGetUsers = async () => [{ usersView: users }];
api.playerDirectory = async (query) => {
  const players = users.filter((user) => user.userName!.toLowerCase().includes(query?.toLowerCase() ?? '')).map((user) => ({ name: user.userName, online: true, status: user.status, level: 3 }));
  return { enabled: true, players, total: players.length, pageSize: 50, offset: 0 };
};
api.presenceGet = async () => ({ status: 'online' });
queryClient.setQueryData(['serverInfo'], { accounts: true, career: false });
queryClient.setQueryData(['tables', 'qa-room'], []);
useSettings.getState().update({ autoPayMana: false, autoPass: false, sound: false, animations: false, matArt: 'none', locale: 'es' });
useSession.setState({ phase: 'signedIn', connection: 'open', userName: 'Felipe', roomId: 'qa-room' });
useLobby.setState({ users, chatId: 'lobby-chat', open: surface !== 'chat', tab: surface === 'directory' ? 'directory' : 'players' });
const session = new GameSession(api, events, { gameId: 'social-fixture', playerId: 'me', mode: 'play' });
events.dispatch({ method: 'GAME_INIT', objectId: 'social-fixture', messageId: 1, data: {
  myPlayerId: 'me', activePlayerId: 'me', activePlayerName: 'Felipe', turn: 4, step: 'PRECOMBAT_MAIN', stack: {},
  players: [{ playerId: 'me', name: 'Felipe', life: 18 }, { playerId: 'rival', name: agent, life: 20 }],
} });
useMatchUi.getState().toggleLog(true);
export function Fixture() {
  const state = useStore(session.store);
  return <QueryClientProvider client={queryClient}><MemoryRouter>
    {surface === 'chat' ? <MatchStage session={session} state={state} seatDisplayNames={{ [agent]: 'Rakún' }} /> : <>
      <main style={{ padding: 24 }}><h1>Playmat</h1><LobbyButton /></main><LobbyDrawer /><ProfileDialog />
    </>}
  </MemoryRouter></QueryClientProvider>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
