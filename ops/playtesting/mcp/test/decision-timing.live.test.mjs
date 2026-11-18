import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { PlaymatEngineSeat } from '../src/engine-seat.mjs';

// Run only inside the disposable engine container's network namespace (see docs/mcp-decision-timing.md).
// No remote URL is accepted: this fixture deliberately lets its synthetic game time out.
test('local XMage inactivity expires with a disabled match clock despite continuous observation', {
  skip: process.env.PLAYMAT_LOCAL_TIMING_FIXTURE !== '1', timeout: 90_000,
}, async t => {
  const seats = ['ClockFixtureA', 'ClockFixtureB'].map(engineName => new PlaymatEngineSeat({
    engineName, engineUrl: 'ws://127.0.0.1:17172/ws', trustedHeader: 'X-Playmat-User',
  }));
  t.after(() => { for (const seat of seats) seat.close(); });
  async function until(condition, description, timeoutMs = 15_000) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      if (await condition()) return;
      await sleep(25);
    }
    throw new Error(`Fixture timed out: ${description}`);
  }
  let inactiveConcede = false;
  let gameEnded = false;
  for (const seat of seats) {
    seat.bus.on('CHATMESSAGE', message => {
      if (/has timed out .*Auto concede/.test(message?.message ?? '')) inactiveConcede = true;
    });
    seat.bus.on('GAME_OVER', () => { gameEnded = true; });
  }
  await until(async () => {
    try { await seats[0].open(); return true; } catch { return false; }
  }, 'local engine ready', 60_000);
  const deck = { name: 'Timing fixture', cards: [{ cardName: 'Forest', amount: 60 }], sideboard: [] };
  let invitation;
  const table = await seats[0].createGame({ name: 'Decision timing fixture', format: 'Pioneer', deck }, async record => {
    invitation = record;
    return {};
  });
  await seats[1].joinGame({ tableId: table.tableId, deck }, invitation, async () => invitation);
  await seats[0].startMatch(table.tableId);
  let pending;
  await until(() => {
    pending = seats.map(seat => seat.snapshot()).find(state => state.decision?.choices?.length);
    return pending;
  }, 'human engine prompt');
  assert.equal(pending.secondsRemaining, null);
  assert.equal(pending.timing.matchClock.status, 'disabled');
  if (pending.timing.inactivity.status === 'running') {
    assert.ok(Number.isFinite(pending.timing.inactivity.deadlineEpochMs));
    assert.ok(pending.timing.inactivity.secondsRemaining >= 0 && pending.timing.inactivity.secondsRemaining <= 3);
    assert.match(pending.timing.warning, /response-inactivity timer/);
  } else {
    // Legacy image acceptance remains available; the full private-image fixture requires the new deadline.
    assert.deepEqual(pending.timing.inactivity, { status: 'unknown', deadlineEpochMs: null, secondsRemaining: null, timeoutSeconds: null });
    assert.match(pending.timing.warning, /null does not mean unlimited time/);
  }
  // Deliberately leave only this disposable fixture unanswered while continuously reading state.
  await until(() => {
    for (const seat of seats) seat.snapshot();
    return inactiveConcede && gameEnded;
  }, 'inactivity auto-concede', 12_000);
  assert.equal(inactiveConcede, true);
  assert.equal(gameEnded, true);
});
