import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createMcpServer } from '../src/server.mjs';

// A scripted game played only from compact receipts: the pilot must always hold the
// rules of every card it can see, and every choice it needs must stay addressable.
const gameId = '00000000-0000-4000-8000-0000000000c1';
const warning = 'Your decision is pending. Answer a current legal choice before the reported deadline.';
const mountain = { id: 'mountain', cardId: 'mountain', name: 'Mountain', controllerId: 'pilot', types: ['LAND'],
  rules: ['{T}: Add {R}.'], manaCost: [], power: '0', toughness: '0' };
const swiftspear = { id: 'swiftspear', cardId: 'swiftspear', name: 'Monastery Swiftspear', controllerId: 'pilot', types: ['CREATURE'],
  rules: ['Haste', 'Prowess'], manaCost: ['{R}'], power: '1', toughness: '2' };
const sheoldred = { id: 'sheoldred', cardId: 'sheoldred', name: 'Sheoldred, the Apocalypse', controllerId: 'rival', types: ['CREATURE'],
  rules: ['Deathtouch', 'Whenever you draw a card, you gain 2 life.'], manaCost: ['{2}', '{B}', '{B}'], power: '4', toughness: '5', tapped: true };
const pass = { id: 'pass', type: 'pass', label: 'Pass' };
const timing = { matchClock: { status: 'disabled' }, inactivity: { status: 'running', secondsRemaining: 500, timeoutSeconds: 600 }, warning };

function script() {
  const battlefield = (own, rival) => [
    { id: 'pilot', name: 'Pilot', yourSeat: true, life: 20, battlefield: own, graveyard: [], exile: [] },
    { id: 'rival', name: 'Rival', life: 1, battlefield: rival, graveyard: [{ ...sheoldred, id: 'old-sheoldred', cardId: 'old-sheoldred', tapped: undefined }], exile: [] },
  ];
  const mana = { id: 'tap-mountain', type: 'manaAbility', label: 'Mountain', objectId: mountain.id, card: { ...mountain, tapped: false, damage: 0 },
    plainMana: true, manaAbilities: [{ abilityId: 'red', manaColors: ['R'] }], payWithOptions: [{ sourceId: mountain.id, abilityId: 'red', color: 'R' }] };
  return {
    keep: { decision: { id: 'keep', kind: 'mulligan', choices: [{ id: 'keep-hand', type: 'button', label: 'Keep' }, { id: 'mulligan', type: 'button', label: 'Mulligan' }] },
      ownHand: [mountain, swiftspear], players: battlefield([], [sheoldred]) },
    'keep-hand': { step: 'PRECOMBAT_MAIN', decision: { id: 'main', kind: 'priority', choices: [pass,
      { id: 'play-mountain', type: 'object', label: 'Mountain', objectId: mountain.id, card: mountain, canPlayLand: true }] } },
    'play-mountain': { ownHand: [swiftspear], players: battlefield([mountain], [sheoldred]), decision: { id: 'main-2', kind: 'priority', choices: [pass, mana,
      { id: 'cast-swiftspear', type: 'object', label: swiftspear.name, objectId: swiftspear.id, card: swiftspear }] } },
    'cast-swiftspear': { ownHand: [], decision: { id: 'pay', kind: 'payMana', instruction: 'Pay {R}', choices: [mana] } },
    'tap-mountain': { players: battlefield([{ ...mountain, tapped: true }], [sheoldred]), stack: [{ ...swiftspear, id: 'swiftspear-spell' }],
      decision: { id: 'resolve', kind: 'priority', choices: [pass] } },
    pass: { stack: [], step: 'DECLARE_ATTACKERS', players: battlefield([{ ...mountain, tapped: true }, swiftspear], [sheoldred]),
      decision: { id: 'attack', kind: 'declareAttackers', choices: [
        { id: 'toggle-swiftspear', type: 'object', label: swiftspear.name, objectId: swiftspear.id, card: swiftspear },
        { id: 'confirm', type: 'button', label: 'Confirm attack', intent: 'confirm_attack' }] } },
    'toggle-swiftspear': { combat: [{ defenderId: 'rival', attackers: [swiftspear], blockers: [], isBlocked: false }],
      decision: { id: 'attack-2', kind: 'declareAttackers', choices: [{ id: 'confirm', type: 'button', label: 'Confirm attack', intent: 'confirm_attack' }] } },
    confirm: { status: 'game_over', decision: null, combat: [], players: battlefield([{ ...mountain, tapped: true }, swiftspear], [sheoldred]).map(
      (player) => player.yourSeat ? player : { ...player, life: 0 }) },
  };
}

async function fixture(t) {
  const steps = script();
  let state = { gameId, cursor: 1, epoch: 1, turn: 1, status: 'active', activePlayerId: 'pilot', phase: 'BEGINNING', step: 'UPKEEP',
    priority: 'self', stack: [], combat: [], revealed: [], lookedAt: [], timing,
    sequenceEvidence: { epoch: 'compact-game', resolutionRevision: 0, resolutions: {}, publicActions: { pilot: 0, rival: 0 },
      informationRevision: 0, combatRevision: 1, combatDamage: [{ revision: 1, sourceId: 'old', controllerId: 'rival', targetId: 'pilot', amount: 3 }] },
    ...steps.keep };
  const listeners = new Set();
  const engine = {
    snapshot: () => state,
    subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    async respond(decisionId, choiceId) {
      const next = steps[choiceId];
      assert.ok(next, `Unexpected choice ${choiceId}`);
      state = { ...state, ...next, cursor: state.cursor + 1 };
      for (const listener of listeners) listener();
      return { submitted: true, gameId, cursor: state.cursor };
    },
  };
  const server = createMcpServer({
    authorize: async (token) => token === 'fixture' ? { accountId: 'fixture', engineName: 'pilot', scopes: ['play'] } : null,
    createEngine: () => engine,
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const client = new Client({ name: 'compact-game', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.address().port}/mcp`), {
    requestInit: { headers: { Authorization: 'Bearer fixture' } },
  }));
  t.after(async () => { await client.close(); server.closeAllConnections(); server.close(); });
  return async (name, args) => {
    const reply = await client.callTool({ name, arguments: args });
    return { text: reply.content[0].text, value: JSON.parse(reply.content[0].text) };
  };
}

test('[PM-VIEW-04] a pilot finishes a game from compact receipts and always knows the rules of visible cards', async (t) => {
  const call = await fixture(t);
  const knownRules = new Map();
  let bytes = 0, responses = 0, warnings = 0;
  const learn = (state) => {
    const cards = [...(state.ownHand ?? []), ...(state.stack ?? []),
      ...(state.players ?? []).flatMap((player) => [...player.battlefield, ...player.graveyard, ...player.exile]),
      ...(state.combat ?? []).flatMap(({ attackers, blockers }) => [...attackers, ...blockers]),
      ...(state.decision?.choices ?? []).flatMap((choice) => choice.card ? [choice.card] : [])];
    for (const card of cards) {
      if (card.rules) knownRules.set(card.name, card.rules);
      assert.ok(knownRules.has(card.name), `${card.name} appeared before its rules were ever sent`);
      assert.ok(card.id, 'Every visible object keeps its ID');
    }
    for (const choice of state.decision?.choices ?? []) {
      if (choice.cardRef) assert.ok(cards.some(({ id }) => id === choice.cardRef), 'A cardRef resolves to a visible object');
    }
    if (state.timing?.warning) warnings++;
  };
  const first = await call('get_game_state', { gameId, view: 'compact' });
  learn(first.value);
  let state = first.value;
  const picks = { keep: 'Keep', main: 'Mountain', 'main-2': 'Monastery Swiftspear', pay: 'Mountain', resolve: 'Pass',
    attack: 'Monastery Swiftspear', 'attack-2': 'Confirm attack' };
  for (let turn = 0; state.status === 'active'; turn++) {
    assert.ok(turn < 10, 'The scripted game ends');
    const { decision } = state;
    const choice = decision.choices.find(({ label }) => label === picks[decision.id]);
    assert.ok(choice, `The compact decision ${decision.id} exposes the intended choice`);
    const action = choice.playLineAction ?? { kind: 'choose', decisionId: decision.id, choiceId: choice.id };
    const receipt = await call('play_line', { gameId, cursor: state.cursor, commandId: `compact-${turn}`, actions: [action], view: 'compact', waitMs: 2000 });
    assert.notEqual(receipt.value.status, 'rejected', receipt.text);
    bytes += receipt.text.length;
    responses++;
    state = receipt.value.state;
    learn(state);
  }
  assert.equal(state.status, 'game_over');
  assert.equal(state.players.find(({ yourSeat }) => !yourSeat).life, 0);
  assert.equal(warnings, 1, 'The unchanged timing warning is sent once per game');
  assert.equal(state.sequenceEvidence.combatDamage, undefined);
  t.diagnostic(`compact receipts: ${responses}, average ${Math.round(bytes / responses)} bytes`);
});
