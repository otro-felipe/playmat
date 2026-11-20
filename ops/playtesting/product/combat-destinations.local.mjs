import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const mountain = 'Mountain';
const creature = 'Falkenrath Gorger';
const walker = 'Tibalt, the Fiend-Blooded';
const battle = 'Invasion of Mercadia';
const printings = {
  [mountain]: { setCode: 'AVR', cardNumber: '239' },
  [creature]: { setCode: 'SOI', cardNumber: '155' },
  [walker]: { setCode: 'AVR', cardNumber: '161' },
  [battle]: { setCode: 'MOM', cardNumber: '147' },
};
const deck = (name, spells) => ({
  name,
  cards: [{ cardName: mountain, amount: 60 - spells.length * 4, ...printings[mountain] },
    ...spells.map(cardName => ({ cardName, amount: 4, ...printings[cardName] }))],
  sideboard: [],
});

function availableMana(state, player) {
  return player.battlefield.filter(card => card.name === mountain && !card.tapped);
}

function setupPlay(state, name) {
  return state.decision.choices.find(choice => choice.card?.name === name
    && state.ownHand.some(card => card.id === choice.card.id));
}

function setupPayment(state, player) {
  if (state.decision.kind !== 'payMana') return null;
  return state.decision.choices.find(choice => availableMana(state, player).some(card => card.id === choice.card?.id));
}

function counter(card, name) {
  return card.counters?.find(entry => entry.name === name)?.count ?? 0;
}

export async function verifyPlaneswalkerCombat({
  startFixture, ownPlayer, rivalPlayer, answer, waitNextOwn, playLineWithPeer, call, totalDeadline, setRivalSetup,
}) {
  for (const defenderName of [walker, battle]) {
    const siege = defenderName === battle;
    const counterName = siege ? 'defense' : 'loyalty';
    const findDefender = state => (siege ? ownPlayer(state) : rivalPlayer(state)).battlefield
      .find(card => card.name === defenderName);
    const findAttacker = state => ownPlayer(state).battlefield.find(card => card.name === creature);
    if (!siege) {
      setRivalSetup(state => {
        const player = ownPlayer(state);
        const payment = setupPayment(state, player);
        if (payment) return payment;
        const ownMain = state.step === 'PRECOMBAT_MAIN' && state.activePlayerId === player.id
          && state.decision.kind === 'priority' && !state.stack.length;
        if (!ownMain || player.battlefield.some(card => card.name === walker)) return undefined;
        if (player.battlefield.length < 2) return setupPlay(state, mountain);
        if (availableMana(state, player).length >= 2) return setupPlay(state, walker);
      });
    }
    let state;
    let attackerCastTurn;
    try {
      state = await startFixture('Isolated permanent defender: ' + defenderName,
        deck('Own combat deck', siege ? [creature, battle] : [creature]), 77,
        deck('Rival combat deck', siege ? [] : [walker]));
      while (Date.now() < totalDeadline) {
        const player = ownPlayer(state);
        const decision = state.decision;
        const ownMain = state.step === 'PRECOMBAT_MAIN' && state.activePlayerId === player.id
          && decision.kind === 'priority' && !state.stack.length;
        if (ownMain && state.turn > attackerCastTurn && findAttacker(state) && findDefender(state)) break;
        const land = ownMain && player.battlefield.filter(card => card.name === mountain).length < (siege ? 2 : 1)
          && setupPlay(state, mountain);
        const creatureSpell = ownMain && !findAttacker(state) && availableMana(state, player).length
          && setupPlay(state, creature);
        const battleSpell = siege && ownMain && !findDefender(state) && availableMana(state, player).length >= 2
          && setupPlay(state, battle);
        const declineDiscard = siege && decision.kind === 'question' && /discard.*draw/i.test(decision.instruction)
          && decision.choices.find(choice => choice.answer === false);
        const protector = siege && decision.kind === 'target' && /protect/i.test(decision.instruction)
          && decision.choices.find(choice => choice.objectId === rivalPlayer(state).id);
        const cleanup = state.step === 'CLEANUP' && decision.choices.find(choice => choice.card?.name === mountain
          && state.ownHand.some(card => card.id === choice.card.id));
        const choice = land || creatureSpell || battleSpell || setupPayment(state, player) || declineDiscard || protector
          || cleanup || decision.choices.find(item => /^Keep\b|^Play first\b/.test(item.label) || item.type === 'pass')
          || decision.choices.find(item => item.intent === 'confirm_attack' || item.intent === 'confirm_block');
        assert.ok(choice, 'Unexpected combat setup prompt ' + decision.kind + ' ' + decision.instruction);
        if (choice === creatureSpell) attackerCastTurn = state.turn;
        await answer(state, choice);
        state = await waitNextOwn(decision.id);
      }
    } finally {
      setRivalSetup(null);
    }
    const attacker = findAttacker(state);
    const defender = findDefender(state);
    assert.ok(attacker && defender && state.turn > attackerCastTurn, 'An attack-ready creature and its exact defender are on the battlefield');
    assert.equal(counter(defender, counterName), siege ? 4 : 2);
    const beforeLife = rivalPlayer(state).life;
    const receipt = await playLineWithPeer({ gameId: state.gameId, cursor: state.cursor, commandId: randomUUID(),
      view: 'compact', waitMs: 15_000, actions: [
        { kind: 'attack', assignments: [{ attackerId: attacker.id, defenderId: defender.id }] },
        { kind: 'pass_until', destination: 'end_step', policy: 'decline_optional' },
      ],
    }, { gameId: state.gameId, turn: state.turn, activePlayerId: state.activePlayerId });
    const context = JSON.stringify({ status: receipt.status, reason: receipt.reason, error: receipt.error,
      step: receipt.state?.step, prompt: receipt.state?.decision?.instruction, completedSteps: receipt.completedSteps });
    assert.equal(receipt.status, 'completed', context);
    assert.equal(receipt.lastDestination.step, 'END_TURN');
    assert.equal(rivalPlayer(receipt.state).life, beforeLife);
    assert.ok(receipt.state.sequenceEvidence.combatDamage.some(hit => hit.sourceId === attacker.id
      && hit.targetId === defender.id && hit.targetPermanent && hit.amount === 2));
    if (siege) {
      assert.equal(counter(findDefender(receipt.state), counterName), 2);
    } else {
      assert.equal(findDefender(receipt.state), undefined);
      assert.ok(rivalPlayer(receipt.state).graveyard.some(card => card.id === defender.cardId));
    }
    console.log(JSON.stringify({ phase: 'PM-LINE-COMBAT-2 real Java', defenderName, reachedEndStep: true }));
    await call('concede', { gameId: state.gameId, entireMatch: true });
  }
}
