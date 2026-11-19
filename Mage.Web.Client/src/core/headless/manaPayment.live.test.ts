/** Run against an isolated XMage server with MAGE_LIVE_SERVER=1. */
import { expect, test, vi } from 'vitest';
import { DEFAULT_SETTINGS, toUserData } from '../../app/stores/settings';
import { parsePayment } from '../game/payment';
import { deck, playBotGame } from './botGame';

vi.mock('../../app/playtesting', () => ({ PRIVATE_PLAYTESTING: true }));

const SERVER_URL = process.env.MAGE_SERVER_URL ?? 'ws://127.0.0.1:17172';

test.skipIf(process.env.MAGE_LIVE_SERVER !== '1')('private payment uses mana from selected lands and keeps previously floated mana', async () => {
  const payments: { symbols: string[]; floatingRed: number }[] = [];
  let floated = false;
  let cast = false;
  let resolvedPool: number | undefined;

  await playBotGame({
    serverUrl: SERVER_URL,
    userName: `mana${Date.now() % 100000}`,
    deck: deck('Payment test', [[36, 'Mountain'], [24, 'Goblin Piker']]),
    aiDeck: deck('Land-only opponent', [[60, 'Island']]),
    userData: toUserData({ ...DEFAULT_SETTINGS, passAfterCasting: false }),
    maxTurns: 16,
    timeoutMs: 120_000,
    stuckMs: 30_000,
    intercept(state) {
      const { interaction, prompt, view } = state;
      if (!view) return undefined;
      const player = view.players?.find(({ playerId }) => playerId === view.myPlayerId);
      const battlefield = Object.values(player?.battlefield ?? {});
      const floatingRed = player?.manaPool?.red ?? 0;
      const mountains = battlefield.filter((card) => card.name === 'Mountain');
      const untapped = mountains.filter((card) => !card.tapped && card.id && interaction.clickable.has(card.id));
      const handIds = [...interaction.clickable.keys()];
      const pass = { type: 'boolean', value: false } as const;

      if (cast && battlefield.some((card) => card.name === 'Goblin Piker')) {
        resolvedPool ??= floatingRed;
        if (interaction.mode === 'priority') return { type: 'action', action: 'CONCEDE' };
      }

      if (cast && prompt?.kind === 'playMana') {
        const symbols = (parsePayment(prompt).cost.match(/\{[^}]+\}/g) ?? []).sort();
        payments.push({ symbols, floatingRed });
        // Only click lands. A third prompt means the two selected Mountains did not pay the spell.
        if (payments.length > 2) return pass;
        const source = untapped[0]?.id;
        return source ? interaction.clickable.get(source) ?? pass : pass;
      }

      if (interaction.mode !== 'priority') return undefined;
      if (cast || view.activePlayerId !== view.myPlayerId || view.step !== 'PRECOMBAT_MAIN') return pass;

      const land = handIds.find((id) => view.myHand?.[id]?.name === 'Mountain');
      if (land && mountains.length < 3) return interaction.clickable.get(land);
      const pikerInHand = Object.values(view.myHand ?? {}).some((card) => card.name === 'Goblin Piker');
      if (!floated && untapped.length === 3 && pikerInHand) {
        floated = true;
        return interaction.clickable.get(untapped[0].id!);
      }

      const spell = handIds.find((id) => view.myHand?.[id]?.name === 'Goblin Piker');
      if (floated && floatingRed === 1 && spell) {
        cast = true;
        return interaction.clickable.get(spell);
      }
      return pass;
    },
  });

  expect(payments).toEqual([
    { symbols: ['{1}', '{R}'], floatingRed: 1 },
    { symbols: ['{1}'], floatingRed: 1 },
  ]);
  expect(resolvedPool).toBe(1);
}, 180_000);

const PAINLAND_MODES = ['{C}', '{G}', '{R}'];

test.skipIf(process.env.MAGE_LIVE_SERVER !== '1').each([
  { land: 'Karplusan Forest', mana: '{C}', modes: PAINLAND_MODES, remainingCost: '{R}', lifeAfter: 20 },
  { land: 'Karplusan Forest', mana: '{R}', modes: PAINLAND_MODES, remainingCost: '{1}', lifeAfter: 19 },
  { land: 'Mana Confluence', mana: 'Blue', modes: ['Black', 'Blue', 'Green', 'Red', 'White'], remainingCost: '{R}', lifeAfter: 19 },
])('manually choosing $mana from $land preserves the mana modes and life change', async ({ land, mana, modes, remainingCost, lifeAfter }) => {
  const spell = 'Goblin Piker';
  const costs: string[] = [];
  let offered: string[] = [];
  let cast = false;
  let clickedLand = false;
  let clickedMountain = false;
  let resolvedLife: number | undefined;

  await playBotGame({
    serverUrl: SERVER_URL,
    userName: `mana${mana.replace(/[^a-z]/gi, '')}${Date.now() % 100000}`,
    deck: deck('Mana choice payment', [[21, 'Mountain'], [21, land], [18, spell]]),
    aiDeck: deck('Land-only opponent', [[60, 'Island']]),
    userData: toUserData({ ...DEFAULT_SETTINGS, passAfterCasting: false }),
    maxTurns: 20,
    timeoutMs: 120_000,
    stuckMs: 30_000,
    intercept({ interaction, prompt, view }) {
      if (!view) return undefined;
      const player = view.players?.find(({ playerId }) => playerId === view.myPlayerId);
      const battlefield = Object.values(player?.battlefield ?? {});
      const source = (name: string) => battlefield.find((card) => card.name === name && !card.tapped);
      const hand = Object.values(view.myHand ?? {});
      const pass = { type: 'boolean', value: false } as const;

      if (cast && battlefield.some((card) => card.name === spell)) {
        resolvedLife = player?.life;
        return { type: 'action', action: 'CONCEDE' };
      }
      if (clickedLand && prompt?.kind === 'chooseAbility') {
        const choices = new Map<string, string>();
        for (const { id, text } of prompt.choices) {
          const symbol = text.match(/Add\s+(\{[CRG]\})/i)?.[1];
          if (symbol) choices.set(symbol, id);
        }
        offered = [...choices.keys()];
        const ability = choices.get(mana);
        return ability ? { type: 'uuid', id: ability } : pass;
      }
      if (clickedLand && prompt?.kind === 'chooseChoice' && prompt.choice.manaColorChoice) {
        offered = prompt.choice.choices ?? [];
        if (offered.includes(mana)) return { type: 'string', value: mana };
      }
      if (cast && prompt?.kind === 'playMana') {
        costs.push(parsePayment(prompt).cost);
        if (!clickedLand) {
          clickedLand = true;
          return interaction.clickable.get(source(land)?.id ?? '') ?? pass;
        }
        if (!clickedMountain) {
          clickedMountain = true;
          return interaction.clickable.get(source('Mountain')?.id ?? '') ?? pass;
        }
        return pass;
      }
      if (interaction.mode !== 'priority') return undefined;
      if (cast || view.activePlayerId !== view.myPlayerId || view.step !== 'PRECOMBAT_MAIN') return pass;

      const landDrop = hand.find((card) => (card.name === land || card.name === 'Mountain')
        && !battlefield.some(({ name }) => name === card.name)
        && interaction.clickable.has(card.id ?? ''));
      if (landDrop?.id) return { type: 'uuid', id: landDrop.id };
      const piker = hand.find((card) => card.name === spell && interaction.clickable.has(card.id ?? ''));
      if (piker?.id && source(land) && source('Mountain')) {
        cast = true;
        return { type: 'uuid', id: piker.id };
      }
      return pass;
    },
  });

  expect([...offered].sort()).toEqual(modes);
  expect(costs).toEqual(['{1}{R}', remainingCost]);
  expect(resolvedLife).toBe(lifeAfter);
}, 180_000);
