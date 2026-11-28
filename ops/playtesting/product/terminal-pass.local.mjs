import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const hasteCreatures = new Set([
  'Fanatical Firebrand', 'Fervent Champion', 'Monastery Swiftspear',
  'Phoenix Chick', 'Rabbit Battery', 'Raging Goblin',
]);
const pilotDeck = {
  name: 'Isolated terminal-pass pilot', cards: [{ cardName: 'Mountain', amount: 60 }], sideboard: [],
};
const peerDeck = {
  name: 'Isolated terminal-pass peer', cards: [
    { cardName: 'Mountain', amount: 36 },
    ...Array.from(hasteCreatures, cardName => ({ cardName, amount: 4 })),
  ], sideboard: [],
};

function passChoice(decision) {
  return decision.choices.find(choice => choice.type === 'pass');
}

function landChoice(decision) {
  return decision.choices.find(choice => choice.canPlayLand && choice.card?.name === 'Mountain');
}

function untappedMountain(player) {
  return player.battlefield.find(card => card.name === 'Mountain' && !card.tapped);
}

function manaChoice(decision, mountain) {
  return decision.choices.find(choice => mountain && (choice.objectId ?? choice.card?.id) === mountain.id);
}

function creatureChoice(decision) {
  return decision.choices.find(choice => hasteCreatures.has(choice.card?.name));
}

function countEvent(state, kind, playerId) {
  return state.sequenceEvidence[kind][playerId] ?? 0;
}

function assertPassOnly(state) {
  assert.equal(state.priority, 'self');
  assert.equal(state.decision.kind, 'priority');
  assert.deepEqual(state.decision.choices.map(choice => choice.type), ['pass']);
}

function passReceiptContext(receipt) {
  const { reason, error, appliedDecisions, state } = receipt;
  const { turn, step, priority, decision } = state ?? {};
  return JSON.stringify({ reason, errorCode: error?.code, appliedDecisions, turn, step, priority,
    decision: decision?.kind, choices: decision?.choices?.map(({ type, plainMana, intent }) => ({ type, plainMana, intent })) });
}

export async function verifyTerminalPass({
  startFixture, ownPlayer, rivalPlayer, answer, waitNextOwn, playLineWithPeer, call, gameClock, setRivalSetup,
}) {
  for (const filtered of [false, true]) {
    let driveRivalActions = false;
    setRivalSetup(state => {
      const decision = state.decision;
      const peer = ownPlayer(state);
      if (decision.kind === 'startingPlayer') return decision.choices.find(choice => choice.label === 'Draw first');
      if (decision.kind === 'payMana') return manaChoice(decision, untappedMountain(peer));
      if (decision.kind === 'declareAttackers' && driveRivalActions) {
        const attacking = state.combat?.some(group => group.attackers.length);
        return decision.choices.find(choice => choice.intent === (attacking ? 'confirm_attack' : 'attack_all'));
      }
      if (decision.kind !== 'priority') return undefined;
      if (driveRivalActions && state.step === 'PRECOMBAT_MAIN' && state.activePlayerId === peer.id && !state.stack.length) {
        if (!peer.battlefield.some(card => card.name === 'Mountain')) return landChoice(decision);
        if (!peer.battlefield.some(card => hasteCreatures.has(card.name)) && untappedMountain(peer)) {
          const choice = creatureChoice(decision);
          assert.ok(choice, 'The fixed-seed opponent has a legal haste creature');
          return choice;
        }
      }
      return passChoice(decision);
    });
    try {
      let state = await startFixture('Isolated terminal-pass acceptance', pilotDeck, 77, peerDeck);
      while (gameClock.hasTime()) {
        const decision = state.decision;
        const pilot = ownPlayer(state);
        const ownPriority = state.priority === 'self' && state.activePlayerId === pilot.id && decision.kind === 'priority';
        if (ownPriority && state.step === 'END_TURN') break;
        const choice = passChoice(decision) || decision.choices.find(choice => /^(Keep|Play first)$/.test(choice.label));
        assert.ok(choice, 'Unplanned terminal-pass setup prompt ' + decision.kind);
        await answer(state, choice);
        state = await waitNextOwn(decision.id);
      }
      assert.equal(state.turn, 1);
      assert.equal(state.step, 'END_TURN');
      assertPassOnly(state);
      const pilotId = ownPlayer(state).id;
      const rivalId = rivalPlayer(state).id;
      assert.equal(ownPlayer(state).battlefield.length, 0);
      assert.equal(state.ownHand.length, 7);
      assert.equal(rivalPlayer(state).battlefield.length, 0);
      assert.equal(countEvent(state, 'spellCasts', rivalId), 0);
      assert.equal(countEvent(state, 'attackerDeclarations', rivalId), 0);
      const previousDraw = state.sequenceEvidence.lastDrawTurn ?? 0;
      const previousHandSize = state.ownHand.length;
      const previousLife = ownPlayer(state).life;

      const toDraw = (current, stopOn) => playLineWithPeer({
        gameId: current.gameId, cursor: current.cursor, commandId: randomUUID(), waitMs: 15_000,
        actions: [{ kind: 'pass_until', destination: 'my_draw', ...(stopOn === undefined ? {} : { stopOn }) }],
      });
      driveRivalActions = true;
      if (filtered) {
        const spell = await toDraw(state, ['new_spell']);
        assert.equal(spell.status, 'interrupted', passReceiptContext(spell));
        assert.equal(spell.reason, 'new_spell', passReceiptContext(spell));
        assertPassOnly(spell.state);
        assert.equal(countEvent(spell.state, 'spellCasts', rivalId), 1);
        assert.equal(countEvent(spell.state, 'attackerDeclarations', rivalId), 0);
        assert.ok(rivalPlayer(spell.state).battlefield.some(card => card.name === 'Mountain'));
        assert.ok(spell.state.stack.some(card => hasteCreatures.has(card.name)), 'The cast is still awaiting a response');

        const attack = await toDraw(spell.state, ['attackers_declared']);
        assert.equal(attack.status, 'interrupted', passReceiptContext(attack));
        assert.equal(attack.reason, 'attackers_declared', passReceiptContext(attack));
        assert.equal(attack.state.step, 'DECLARE_ATTACKERS');
        assertPassOnly(attack.state);
        assert.equal(countEvent(attack.state, 'attackerDeclarations', rivalId), 1);
        assert.ok(attack.state.combat.some(group => group.attackers.length > 0));
        state = attack.state;
      }

      const draw = await toDraw(state);
      assert.equal(draw.status, 'completed', passReceiptContext(draw));
      assert.equal(draw.lastDestination.step, 'DRAW');
      assert.equal(draw.state.activePlayerId, pilotId);
      assert.equal(draw.state.priority, 'self');
      assert.equal(draw.state.decision.kind, 'priority');
      assert.equal(draw.needsAgent, true);
      assert.ok(draw.state.sequenceEvidence.lastDrawTurn > previousDraw);
      assert.equal(draw.state.sequenceEvidence.lastDrawTurn, draw.lastDestination.turn);
      assert.equal(draw.state.ownHand.length, previousHandSize + 1);
      assert.equal(countEvent(draw.state, 'spellCasts', rivalId), 1);
      assert.equal(countEvent(draw.state, 'attackerDeclarations', rivalId), 1);
      assert.ok(ownPlayer(draw.state).life < previousLife, 'The opponent actually dealt combat damage');
      const stillWaiting = await call('get_game_state', { gameId: draw.state.gameId });
      assert.equal(stillWaiting.decision.id, draw.state.decision.id, 'The line did not consume draw-step priority');
      console.log(JSON.stringify({ phase: 'PM-LINE-02 real XMage terminal pass', filtered,
        destination: draw.lastDestination.step, decisions: draw.appliedDecisions }));
      await call('concede', { gameId: state.gameId, entireMatch: true });
    } finally {
      setRivalSetup(null);
    }
  }
}
