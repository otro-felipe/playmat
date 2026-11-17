import { expect, test } from 'vitest';
import type { PermanentView, PlayerView } from '../../protocol/generated/views';
import { planPayment } from './paymentPlan';
import { poolId } from './payment';
import { parsePrompt, type PlayManaPrompt } from './prompt';

const forest: PermanentView = { id: 'forest', cardTypes: ['LAND'], subTypes: ['FOREST'] };
const island: PermanentView = { id: 'island', cardTypes: ['LAND'], subTypes: ['ISLAND'] };
function plan(cost: string, player: PlayerView, ids = Object.keys(player.battlefield ?? {})) {
  const prompt = parsePrompt('GAME_PLAY_MANA', { message: `Pay ${cost}` }) as PlayManaPrompt;
  return planPayment(prompt, player, new Map(ids.map((id) => [id, {}])), [], { hybrid: true });
}

test('does not tap anything when the complete colored cost cannot be covered', () => {
  expect(plan('{1}{G}', { battlefield: { forest } })).toEqual({ next: null, reason: 'insufficient' });
  expect(plan('{U}', { battlefield: { forest } })).toEqual({ next: null, reason: 'insufficient' });
  expect(plan('{G}', { battlefield: { forest: { ...forest, tapped: true } } })).toEqual({ next: null, reason: 'insufficient' });
});

test('uses a floating unit before tapping another source and reserves the needed color', () => {
  const green = poolId('GREEN');
  const colorless = poolId('COLORLESS');
  expect(plan('{1}{G}', { battlefield: { forest }, manaPool: { colorless: 1 } }, ['forest', colorless]).next?.id).toBe(colorless);
  expect(plan('{1}{G}', { manaPool: { green: 1, colorless: 1 } }, [green, colorless]).next?.id).toBe(green);
  expect(plan('{2}', { manaPool: { green: 2 } }, [green]).next?.id).toBe(green);
});

test('can finish after a manual tap, ignoring tapped and nonclickable permanents', () => {
  expect(plan('{G}', { battlefield: { forest, island: { ...island, tapped: true } } }).next).toEqual({ id: 'forest', color: 'G', ask: false });
  expect(plan('{G}', { battlefield: { forest } }, []).next).toBeNull();
});

test('unknown sources and special costs are left to manual payment with an honest status', () => {
  const mystery: PermanentView = { id: 'mystery', cardTypes: ['LAND'], rules: ['{T}, Sacrifice a creature: Add {G}.'] };
  expect(plan('{G}', { battlefield: { mystery } })).toEqual({ next: null, reason: 'manual' });
  expect(plan('{X}', { battlefield: { forest } })).toEqual({ next: null, reason: 'manual' });
});

test('does not tap a manland to pay for its own animation', () => {
  const prompt = parsePrompt('GAME_PLAY_MANA', { message: "Pay {G}<div><font object_id='forest'>Forest animation</font></div>" }) as PlayManaPrompt;
  expect(planPayment(prompt, { battlefield: { forest } }, new Map([['forest', {}]]), [], {}).next).toBeNull();
});
