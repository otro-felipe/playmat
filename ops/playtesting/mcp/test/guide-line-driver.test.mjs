import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const guide = await readFile(new URL('../guides/turn-planning.md', import.meta.url), 'utf8');
const snippets = [...guide.matchAll(/```js\n([\s\S]*?)\n```/g)].map(match => match[1]);

// Run the copyable client example with an observed seat and a sequence of MCP receipts.
function driver() {
  const source = snippets.find(snippet => snippet.includes('async function runLine('));
  assert.ok(source, 'Publish the client function that drives one declared line to its stopping point');
  return Function(source + '\nreturn runLine;')();
}

const state = { gameId: 'game', cursor: 50 };
const actions = [
  { kind: 'attack', attackers: ['creature'] },
  { kind: 'pass_until', destination: 'end_step', policy: 'decline_optional' },
];

for (const seat of [{ playerId: 'player' }, { humanTableId: 'human-table' }]) {
  test('guide keeps the same command and seat through routine callbacks for ' + Object.keys(seat)[0], async () => {
    const calls = [];
    const current = { gameId: 'game', cursor: 53, decision: { id: 'observed-response' } };
    const replies = [
      { status: 'running', commandId: 'planned', planOwnsExecution: true },
      { status: 'running', commandId: 'planned', planOwnsExecution: true },
      { status: 'interrupted', commandId: 'planned', planOwnsExecution: false, needsAgent: true, state: current },
    ];
    const client = { async callTool(input) {
      calls.push(input);
      return { content: [{ type: 'text', text: JSON.stringify(replies.shift()) }] };
    } };
    const receipt = await driver()(client, seat, state, actions, 'planned');
    assert.deepEqual(receipt.state, current);
    assert.deepEqual(calls.map(({ name }) => name), ['play_line', 'wait_for_decision', 'wait_for_decision']);
    assert.deepEqual(calls[0].arguments.actions, actions);
    for (const call of calls) {
      assert.equal(call.arguments[Object.keys(seat)[0]], Object.values(seat)[0]);
      assert.equal(call.arguments.commandId, 'planned');
      assert.equal(call.arguments.gameId, 'game');
    }
    assert.ok(calls[0].arguments.waitMs > 0);
    assert.ok(calls[0].arguments.waitMs <= 25_000);
    assert.ok(calls.slice(1).every(c => c.arguments.timeoutMs === 25_000 && !('actions' in c.arguments)));
  });
}

for (const receipt of [
  { event: 'rollback', planOwnsExecution: true, state: { rollbackRequest: {} } },
  { status: 'rejected', planOwnsExecution: false, code: 'stale_decision', state: { cursor: 51 } },
  { status: 'ended', planOwnsExecution: false, event: 'match_over' },
]) {
  test('guide returns ' + (receipt.event ?? receipt.code) + ' directly to the player', async () => {
    let calls = 0;
    const client = { async callTool() {
      assert.equal(++calls, 1);
      return { structuredContent: receipt };
    } };
    assert.deepEqual(await driver()(client, { playerId: 'player' }, state, actions, 'planned'), receipt);
  });
}
