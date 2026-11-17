import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { ToolError } from './game-seat.mjs';

const COLORS = {
  W: 'white', U: 'blue', B: 'black', R: 'red', G: 'green', C: 'colorless',
};

const keywordPatterns = [
  'Deathtouch', 'Defender', 'Double strike', 'First strike', 'Flash', 'Flashback', 'Flying', 'Haste',
  'Hexproof', 'Indestructible', 'Lifelink', 'Menace', 'Protection', 'Reach', 'Trample', 'Vigilance', 'Ward',
  'Cycling', 'Surveil', 'Scry', 'Kicker', 'Adventure', 'Escape', 'Delve', 'Prowess', 'Split second',
  'Convoke', 'Affinity', 'Channel', 'Exile', 'Counter', 'Destroy',
];

const sourceDirs = [
  new URL('../meta-decks/', import.meta.url),
  new URL('../../../../Mage.Web.Client/public/meta-decks/', import.meta.url),
];

let snapshot;
async function loadSnapshot() {
  if (!snapshot) snapshot = (async () => {
    for (const root of sourceDirs) {
      try {
        return { ...JSON.parse(await readFile(new URL('index.json', root), 'utf8')), root };
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    return null;
  })();
  return snapshot;
}

export function formatTag(format) { return `Constructed - ${format}`; }

function normalized(text) { return String(text ?? '').toLowerCase().replace(/[-'’ ]/g, ''); }

export function cardCatalogEntry(card) {
  if (!card) return null;
  const cost = Array.isArray(card.manaCostLeftStr) ? card.manaCostLeftStr : [];
  const manaSymbols = cost.flatMap((entry) => {
    const braces = [...String(entry).matchAll(/\{([^{}]+)\}/g)];
    return braces.length ? braces.map((s) => s[1]) : [String(entry)];
  });
  const colors = Object.keys(COLORS).filter((color) => color !== 'C' && card.color?.[COLORS[color]]);
  const rules = card.rules ?? [];
  const keywords = keywordPatterns.filter((keyword) => {
    const expression = new RegExp(`(?:^|[,.;:]\\s*|<br\\s*/?>\\s*)${keyword}(?=$|[ ,.;:(])`, 'i');
    return rules.some((rule) => expression.test(String(rule).replace(/<(?!br\b)[^>]+>/gi, '')));
  });
  return {
    name: card.name ?? card.displayName, setCode: card.expansionSetCode, cardNumber: card.cardNumber,
    colors, manaSymbols, manaValue: card.manaValue, types: card.cardTypes ?? [], keywords, rules,
    engineAvailable: true,
  };
}

export async function searchCards(engine, query) {
  const { offset = 0, limit = 25, minManaValue, maxManaValue, types, colors, keywords, manaSymbols, query: text } = query;
  // Request filtered pages from the real catalog where available, then match exact data in the
  // local projection. Continue over at most ten source pages to keep uncommon text filters bounded.
  const pageSize = 100;
  const criteria = {
    format: query.format ? formatTag(query.format) : undefined,
    webColors: colors?.map((color) => COLORS[color]),
    colorMatch: 'any',
    types, uniqueNames: true,
    ...(maxManaValue !== undefined ? { manaValue: maxManaValue, manaValueOperator: 'lte' }
      : minManaValue !== undefined ? { manaValue: minManaValue, manaValueOperator: 'gte' } : {}),
    ...(text ? { searchText: text, searchNames: true, searchRules: true, searchTypes: true } : {}),
  };
  const cards = [];
  let cursor = offset;
  let exhausted = false;
  for (let pageIndex = 0; pageIndex < 10 && cards.length < limit && !exhausted; pageIndex++) {
    const page = await engine.searchCards({ ...criteria, start: cursor, count: pageSize });
    for (const card of page) {
      cursor++;
      if (minManaValue !== undefined && card.manaValue < minManaValue) continue;
      if (maxManaValue !== undefined && card.manaValue > maxManaValue) continue;
      if (colors?.length && !colors.some((color) => color === 'C' ? card.colors.length === 0 : card.colors.includes(color))) continue;
      if (manaSymbols?.length && !manaSymbols.every((symbol) => card.manaSymbols.includes(symbol))) continue;
      if (keywords?.length && !keywords.every((keyword) => card.keywords?.some((known) => normalized(known) === normalized(keyword)))) continue;
      cards.push(query.format ? { ...card, formatLegal: true } : card);
      if (cards.length === limit) break;
    }
    exhausted = cursor === (offset + pageIndex * pageSize + page.length) && page.length < pageSize;
  }
  return {
    cards,
    nextOffset: exhausted ? null : cursor,
    format: query.format ?? null,
    formatSelection: query.format ? 'Card eligibility in the pinned engine. Use validate_deck to check the entire list.' : null,
  };
}

export async function listArchetypes(format) {
  const index = await loadSnapshot();
  if (!index) return { archetypes: [], provenance: null };
  return {
    archetypes: index.decks.filter((deck) => deck.format === formatTag(format))
      .map(({ name, source, tier }) => ({ name, source, tier })),
    provenance: { date: index.updated, source: index.source },
  };
}

export async function possibleResponses(engine, { archetype, ...query }) {
  const index = await loadSnapshot();
  const sample = index?.decks.find((deck) => deck.format === formatTag(query.format)
    && normalized(archetype) === normalized(deck.name));
  if (sample && basename(sample.file) !== sample.file) throw new ToolError('invalid_sample', 'The bundled archetype is invalid.');
  const result = await searchCards(engine, query);
  const publicNames = new Set();
  if (sample) {
    const deck = await readFile(new URL(sample.file, index.root), 'utf8');
    for (const line of deck.split(/\r?\n/)) {
      const entry = /^(?:SB:\s*)?\d+\s+(?:\[[^\]]+\]\s+)?(.+)$/.exec(line);
      if (entry) publicNames.add(normalized(entry[1]));
    }
  }
  const cards = result.cards.map((card) => ({ ...card, inPublicSample: publicNames.has(normalized(card.name)) }));
  cards.sort((left, right) => Number(right.inPublicSample) - Number(left.inPublicSample));
  return {
    ...result, cards,
    hypothesis: archetype ?? null,
    publicSample: sample?.name ?? null,
    provenance: index ? { date: index.updated, source: sample?.source ?? index.source } : null,
    interpretation: 'Possibilities from dated public examples and the catalog. The opposing seat and its private cards are not consulted.',
  };
}
