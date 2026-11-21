import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';

export const hostDeck = {
  name: 'Pioneer fixture',
  cards: [{ cardName: 'Forest', setCode: 'M15', cardNumber: '266', amount: 60 }],
  sideboard: [{ cardName: 'Mountain', setCode: 'M15', cardNumber: '262', amount: 8 }],
};
export const guestDeck = {
  name: 'Guest fixture',
  cards: [{ cardName: 'Island', setCode: 'M15', cardNumber: '254', amount: 60 }],
  sideboard: [{ cardName: 'Plains', setCode: 'M15', cardNumber: '250', amount: 8 }],
};

function distribution(deck) {
  const canonical = rows => rows.map(({ cardName, setCode, cardNumber, amount }) =>
    [cardName, setCode, cardNumber, amount]).sort((a, b) => a[0].localeCompare(b[0]));
  return [canonical(deck.cards), canonical(deck.sideboard)];
}

function exchange(deck, amount) {
  const [main] = deck.cards;
  const [reserve] = deck.sideboard;
  return { ...deck, cards: [{ ...main, amount: main.amount - amount }, { ...reserve, amount }],
    sideboard: [{ ...reserve, amount: reserve.amount - amount }, { ...main, amount }] };
}

export async function until(predicate, description, deadlineMs = 15_000) {
  const end = Date.now() + deadlineMs;
  while (Date.now() < end) {
    const result = await predicate();
    if (result) return result;
    await sleep(125);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

export async function verifySideboarding(host, guest, playerNames) {
  const clients = [host, guest];
  const read = (client) => client('get_game_state');
  async function playOpenDecision(client, landPlayed, state = null) {
    state ??= await read(client);
    const decision = state.decision;
    if (state.status !== 'active' || !state.gameId || !decision) return false;
    const pick = (pattern) => decision.choices.find((choice) => pattern.test(choice.label));
    const land = !landPlayed.value && decision.kind === 'priority' && decision.choices.find((choice) =>
      choice.card?.types.includes('LAND') && state.ownHand.some((card) => card.id === choice.card.id));
    const chosen = land || pick(/^Keep\b|^Play first\b/) || decision.choices.find((choice) => choice.type === 'pass')
      || decision.choices.find((choice) => choice.type === 'button') || decision.choices[0];
    if (!chosen) return false;
    const result = await client('submit_decision', { gameId: state.gameId, decisionId: decision.id, choiceId: chosen.id, idempotencyKey: decision.id },
      ['not_actionable', 'stale_decision']);
    if (!result) return false;
    assert.equal(result.submitted, true);
    if (land) landPlayed.value = true;
    return state;
  }

  async function playUntilLand(excludedId) {
    const landPlayed = { value: false };
    let playedDuringOpponentTurn = false;
    let lastResync = Date.now();
    const gameId = await until(async () => {
      const states = await Promise.all(clients.map(read));
      const [first, second] = states;
      if (!first.gameId || first.gameId === excludedId || first.gameId !== second.gameId) return false;
      for (const [index, client] of clients.entries()) {
        const action = await playOpenDecision(client, landPlayed, states[index]);
        if (action?.decision?.kind === 'priority' && action.activePlayer !== playerNames[index]) playedDuringOpponentTurn = true;
      }
      if (Date.now() - lastResync > 8_000 && states.every((state) => state.status === 'active' && !state.decision)) {
        lastResync = Date.now();
        await Promise.all(clients.map((client) => client('resync_game', { gameId: first.gameId }, ['forbidden_game'])));
      }
      if (!landPlayed.value || !playedDuringOpponentTurn) return false;
      return first.gameId;
    }, 'typed choice and ordinary priority on an opponent turn in new game', 60_000);
    return gameId;
  }

  const firstGameId = await playUntilLand();
  await guest('send_chat', { gameId: firstGameId, message: 'BDD fixture greeting' });
  await until(async () => (await host('list_chat', { gameId: firstGameId })).messages.some((m) => m.message === 'BDD fixture greeting'),
    'game chat received');
  await host('concede', { gameId: firstGameId, entireMatch: false });
  async function sideboardWindow(gameId) {
    await until(async () => (await Promise.all(clients.map(read))).every(state => state.status === 'sideboarding'),
      'both seats enter sideboarding');
    return Promise.all(clients.map(client => client('get_sideboard_state', { gameId })));
  }
  const opening = await sideboardWindow(firstGameId);
  const decks = [hostDeck, guestDeck];
  const changed = [];
  for (const [index, client] of clients.entries()) {
    const { decisionId, deck } = opening[index];
    assert.deepEqual(distribution(deck), distribution(decks[index]), 'current pool and printing for the selected seat');
    assert.equal(await client('submit_sideboard', { gameId: firstGameId, decisionId: opening[1 - index].decisionId, deck },
      ['stale_decision']), null, 'the other seat cannot submit this decision');
    const outsidePool = { ...deck, sideboard: [{ cardName: 'Swamp', amount: 8 }] };
    assert.equal(await client('submit_sideboard', { gameId: firstGameId, decisionId, deck: outsidePool },
      ['sideboard_refused', 'operation_failed']), null, 'XMage refuses a legal card outside the pool');
    const stillOpen = await client('get_sideboard_state', { gameId: firstGameId });
    assert.equal(stillOpen.submitted, false);
    assert.equal(stillOpen.decisionId, decisionId);
    assert.deepEqual(distribution(stillOpen.deck), distribution(deck));
    const amount = index === 0 ? 2 : 4;
    changed.push(exchange(deck, amount));
    const accepted = await client('submit_sideboard', { gameId: firstGameId, decisionId, deck: changed[index] });
    assert.equal(accepted.submitted, true);
    assert.deepEqual(accepted.mainDeckChanges, { status: 'available',
      broughtIn: [{ name: deck.sideboard[0].cardName, amount }], tookOut: [{ name: deck.cards[0].cardName, amount }] });
  }

  const secondGameId = await playUntilLand(firstGameId);
  assert.notEqual(firstGameId, secondGameId);
  await guest('concede', { gameId: secondGameId, entireMatch: false });
  const latest = await sideboardWindow(secondGameId);
  for (const [index, client] of clients.entries()) {
    const { decisionId, deck } = latest[index];
    assert.notEqual(decisionId, opening[index].decisionId);
    assert.deepEqual(distribution(deck), distribution(changed[index]), 'G3 prompt starts from the actual G2 list');
    assert.equal(await client('submit_sideboard', {
      gameId: secondGameId, decisionId: opening[index].decisionId, deck,
    }, ['stale_decision']), null);
    const proposed = index === 0 ? opening[index].deck : deck;
    const accepted = await client('submit_sideboard', { gameId: secondGameId, decisionId, deck: proposed });
    assert.equal(accepted.submitted, true);
    assert.deepEqual(accepted.mainDeckChanges, index === 0 ? { status: 'available',
      broughtIn: [{ name: 'Forest', amount: 2 }], tookOut: [{ name: 'Mountain', amount: 2 }] }
      : { status: 'available', broughtIn: [], tookOut: [] }, 'deliberate revert and exact keep both accepted');
  }

  const thirdGameId = await playUntilLand(secondGameId);
  assert.notEqual(thirdGameId, firstGameId);
  await host('concede', { gameId: thirdGameId, entireMatch: false });
  await until(async () => {
    const result = await read(guest);
    return result.status === 'match_over' && result.score?.wins === 2 && result.score.losses === 1;
  }, '2–1 match result');

  return [firstGameId, secondGameId, thirdGameId];
}
