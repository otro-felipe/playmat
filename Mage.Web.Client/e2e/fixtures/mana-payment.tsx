import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { useStore } from 'zustand';
import { GameSession } from '../../src/core/game/gameSession';
import type { GameView, PermanentView } from '../../src/protocol/generated/views';
import { api, events } from '../../src/app/connection';
import { queryClient } from '../../src/app/queries';
import { MatchStage } from '../../src/app/match/MatchStage';
import { useSettings } from '../../src/app/stores/settings';
import '../../src/app/styles/base.css';

// Isolated local UI scenario: all game answers are recorded, no game server is contacted.
const params = new URLSearchParams(location.search);
useSettings.getState().update({ autoPayMana: false, autoPayRestricted: true, autoPass: false, sound: false, animations: false, matArt: 'none', locale: params.get('lang') === 'es' ? 'es' : 'en' });
queryClient.setQueryData(['serverInfo'], { accounts: false });
const session = new GameSession(api, events, { gameId: 'payment-fixture', playerId: 'me', mode: 'play' });
const calls: string[] = [];
const land = (id: string, name: string, type: 'FOREST' | 'ISLAND'): PermanentView => ({ id, name, cardTypes: ['LAND'], subTypes: [type], rules: [`{T}: Add {${type === 'FOREST' ? 'G' : 'U'}}.`], tapped: false });
const forest = land('forest', 'Forest', 'FOREST');
const island = land('island', 'Island', 'ISLAND');
const insufficient = params.get('scenario') === 'insufficient';
const view: GameView = {
  myPlayerId: 'me', activePlayerId: 'me', activePlayerName: 'Player', priorityPlayerName: 'Player', turn: 3, step: 'PRECOMBAT_MAIN',
  players: [
    { playerId: 'me', name: 'Player', life: 18, libraryCount: 51, handCount: 3, battlefield: insufficient ? { forest } : { forest, island }, manaPool: params.has('pool') ? { green: 1 } : {} },
    { playerId: 'them', name: 'Opponent', life: 20, libraryCount: 52, handCount: 4, battlefield: { opponentForest: { ...forest, id: 'opponentForest', tapped: true } } },
  ],
  stack: { spell: { id: 'spell', name: 'Elvish Visionary', manaCostLeftStr: ['{1}', '{G}'], cardTypes: ['CREATURE'] } },
  myHand: { hand: { id: 'hand', name: 'Forest', cardTypes: ['LAND'] } },
  canPlayObjects: { objects: insufficient ? { forest: {} } : { forest: {}, island: {} } },
};
let remaining = '{1}{G}';
let messageId = 0;
function show(cost: string | null) {
  events.dispatch({ method: cost ? 'GAME_PLAY_MANA' : 'GAME_SELECT', objectId: 'payment-fixture', messageId: ++messageId, data: {
    message: cost ? `Pay ${cost}<div><font object_id='spell'>Elvish Visionary</font></div>` : 'Play spells and abilities', gameView: structuredClone(view),
  } });
}
api.sendPlayerAction = async () => true;
api.sendPlayerUUID = async (_gameId, id) => {
  calls.push(String(id));
  setTimeout(() => {
    const me = view.players![0];
    if (id && me.battlefield?.[id]) me.battlefield = { ...me.battlefield, [id]: { ...me.battlefield[id], tapped: true } };
    remaining = remaining.includes('{G}') ? '{1}' : '';
    if (!remaining) view.stack = {};
    show(remaining || null);
  }, 300);
};
api.sendPlayerBoolean = async (_gameId, answer) => {
  calls.push(answer ? 'confirm' : params.get('scenario') === 'priority' ? 'pass' : 'cancel');
  view.stack = {};
  show(null);
};
api.sendPlayerManaType = async (_gameId, _playerId, type) => {
  calls.push(type);
  setTimeout(() => {
    view.players![0].manaPool = {};
    remaining = '{1}';
    show(remaining);
  }, 300);
};
show(params.get('scenario') === 'priority' ? null : remaining);
Object.assign(window, { paymentFixture: { calls, session } });
export function Fixture() {
  const state = useStore(session.store);
  return <QueryClientProvider client={queryClient}><MemoryRouter><MatchStage session={session} state={state} /></MemoryRouter></QueryClientProvider>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
