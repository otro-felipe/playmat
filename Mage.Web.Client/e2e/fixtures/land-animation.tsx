import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { useStore } from 'zustand';
import type { GameView } from '../../src/protocol/generated/views';
import { GameSession } from '../../src/core/game/gameSession';
import { api, events } from '../../src/app/connection';
import { MatchStage } from '../../src/app/match/MatchStage';
import { queryClient } from '../../src/app/queries';
import { useSettings } from '../../src/app/stores/settings';
import '../../src/app/styles/base.css';

useSettings.getState().update({ locale: 'es', autoPass: false, autoPayMana: false, animations: false, sound: false, matArt: 'none' });
queryClient.setQueryData(['serverInfo'], { accounts: false });
const session = new GameSession(api, events, { gameId: 'fixture', playerId: 'me', mode: 'play' });
const picks: string[] = [];
api.sendPlayerUUID = async (_game, id) => { picks.push(id); };
const forest = { name: 'Forest', displayName: 'Bosque', cardTypes: ['LAND' as const], controllerId: 'me',
  paintedLand: '/career-art/land/vista-forest.webp', zone: 'BATTLEFIELD' as const };
const view: GameView = { myPlayerId: 'me', activePlayerId: 'me', activePlayerName: 'Azul', turn: 3, step: 'PRECOMBAT_MAIN',
  players: [
    { playerId: 'me', name: 'Azul', life: 20, battlefield: {
      first: { ...forest, id: 'first', summoningSickness: false }, second: { ...forest, id: 'second', summoningSickness: true } } },
    { playerId: 'other', name: 'Verde', life: 20 },
  ],
};
Object.assign(window, { landAnimationPicks: picks });
events.dispatch({ method: 'GAME_TARGET', objectId: 'fixture', messageId: 1, data: {
  message: 'Elige la tierra objetivo.', targets: ['first','second'], flag: true,
  options: { targetAnimation: 'becomesCreature' }, gameView: view,
} });
export function Fixture() {
  const state = useStore(session.store);
  return <QueryClientProvider client={queryClient}><MemoryRouter><MatchStage session={session} state={state} /></MemoryRouter></QueryClientProvider>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
