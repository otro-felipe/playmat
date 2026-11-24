#!/usr/bin/env node
// Replays the play_line, wait_for_decision and get_game_state responses recorded in a
// pilot's native JSONL through the current compact view and reports their sizes.
// Usage: node scripts/measure-compact-view.mjs <pilot.jsonl>
import { readFileSync } from 'node:fs';
import { compactGameState, createViewMemory, resetViewMemory } from '../src/state-view.mjs';

const [path] = process.argv.slice(2);
if (!path) throw new Error('Usage: measure-compact-view.mjs <pilot.jsonl>');
const tools = new Map();
const rows = [];
for (const line of readFileSync(path, 'utf8').split('\n')) {
  if (!line.trim()) continue;
  const content = JSON.parse(line).message?.content;
  if (!Array.isArray(content)) continue;
  for (const part of content) {
    if (part.type === 'tool_use') tools.set(part.id, part.name.split('__').at(-1));
    if (part.type !== 'tool_result' || !tools.has(part.tool_use_id)) continue;
    const tool = tools.get(part.tool_use_id);
    if (!['play_line', 'wait_for_decision', 'get_game_state'].includes(tool)) continue;
    const text = Array.isArray(part.content) ? part.content.map(({ text = '' }) => text).join('') : part.content;
    try { rows.push({ tool, text, value: JSON.parse(text) }); } catch { /* transport errors are not states */ }
  }
}
const memory = createViewMemory();
let before = 0, after = 0, count = 0;
for (const { tool, text, value } of rows) {
  const state = tool === 'get_game_state' ? value : value.state;
  if (!state?.gameId) continue;
  if (tool === 'get_game_state') resetViewMemory(memory);
  const compact = compactGameState(state, memory);
  const replayed = tool === 'get_game_state' ? compact : { ...value, state: compact };
  before += text.length;
  after += JSON.stringify(replayed).length;
  count++;
}
const kb = (n) => (n / 1024).toFixed(1);
console.log(JSON.stringify({ responses: count, beforeTotalKB: kb(before), afterTotalKB: kb(after),
  beforeAvgKB: kb(before / count), afterAvgKB: kb(after / count), reduction: `${(100 * (1 - after / before)).toFixed(1)}%` }));
