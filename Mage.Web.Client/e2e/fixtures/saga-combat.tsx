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

// Local presentation fixture: no engine connection and no game commands leave this page.
const params = new URLSearchParams(location.search);
const blocking = params.get('mode') === 'block';
const crowded = params.has('crowded');
useSettings.getState().update({ autoPayMana: false, autoPass: false, autoCrew: false, attackPlayerByDefault: false, sound: false, animations: false, matArt: 'none', locale: 'es' });
queryClient.setQueryData(['serverInfo'], { accounts: false });
const session = new GameSession(api, events, { gameId: 'fixture', playerId: 'me', mode: 'play' });
const calls: boolean[] = [];
api.sendPlayerAction = async () => true;
api.sendPlayerBoolean = async (_gameId, answer) => { calls.push(answer); };
const body = (id: string, owner: string): PermanentView => ({ id, name: `Bear ${id}`, power: '2', toughness: '2', cardTypes: ['CREATURE'], controllerId: owner, ownerId: owner });
const saga: PermanentView = { id: 'saga', name: 'Binding the Old Gods', cardTypes: ['ENCHANTMENT'], subTypes: ['SAGA'], counters: [{ name: 'lore', count: Number(params.get('chapter') ?? 1) }], rules: ['I — Destroy target nonland permanent an opponent controls.', 'II — Search your library for a Forest card.', 'III — Creatures you control gain deathtouch.'], tapped: params.has('tapped') };
const enchantments = [saga, ...[2, 3].map((count) => ({ ...saga, id: `saga-${count}`, name: `Saga ${count}`, tapped: false, counters: [{ name: 'lore', count }] }))];
const attacker = body('attacker', blocking ? 'them' : 'me');
const blocker = body('blocker', 'me');
const attackers = Array.from({ length: crowded ? 8 : 1 }, (_, index) => index === 0 ? attacker : body(`a${index}`, blocking ? 'them' : 'me'));
const blockers = Array.from({ length: crowded ? 8 : 1 }, (_, index) => index === 0 ? blocker : body(`b${index}`, 'me'));
const view: GameView = {
  myPlayerId: 'me', activePlayerId: blocking ? 'them' : 'me', activePlayerName: blocking ? 'Rival' : 'Felipe', turn: 4,
  step: blocking ? 'DECLARE_BLOCKERS' : 'DECLARE_ATTACKERS', stack: {},
  players: [
    { playerId: 'me', name: 'Felipe', life: 20, battlefield: Object.fromEntries([...enchantments, ...(blocking ? blockers : attackers)].map((card) => [card.id!, card])) },
    { playerId: 'them', name: 'Rival', life: 18, battlefield: Object.fromEntries((blocking ? attackers : [body('opponent', 'them')]).map((card) => [card.id!, card])) },
  ],
  combat: attackers.map((card, index) => ({ attackers: { [card.id!]: card }, blockers: blocking ? { [blockers[index].id!]: blockers[index] } : {}, defenderId: blocking ? 'me' : 'them', defenderName: blocking ? 'Felipe' : 'Rival' })),
};
let messageId = 0;
function show() {
  events.dispatch({ method: 'GAME_SELECT', objectId: 'fixture', messageId: ++messageId, data: {
    message: blocking ? 'Choose blockers' : 'Choose attackers', gameView: structuredClone(view),
    options: blocking ? { possibleBlockers: blockers.map((card) => card.id!) } : { possibleAttackers: attackers.map((card) => card.id!) },
  } });
}
show();
Object.assign(window, { sagaCombatFixture: { calls, setLore(count: number) { saga.counters = [{ name: 'lore', count }]; show(); } } });
export function Fixture() {
  const state = useStore(session.store);
  return <QueryClientProvider client={queryClient}><MemoryRouter><MatchStage session={session} state={state} /></MemoryRouter></QueryClientProvider>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
