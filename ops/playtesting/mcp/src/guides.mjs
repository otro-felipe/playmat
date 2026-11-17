import { readFileSync } from 'node:fs';

const mimeType = 'text/markdown';
const guides = [
  {
    name: 'getting-started', title: 'Start a Playmat match',
    description: 'Join with an invite, use engine decisions, sideboard, and follow the table’s chat mode.',
  },
  {
    name: 'card-catalog', title: 'Cards and matchups',
    description: 'Look up cards, validate decks, and estimate responses from public information.',
  },
  {
    name: 'turn-planning', title: 'Plan a turn',
    description: 'Pick a competitive line and use guarded sequences that stop when the game changes.',
  },
  {
    name: 'rules', title: 'Magic rules',
    description: 'Find the official downloadable Comprehensive Rules and sections for common timing questions.',
  },
].map(({ name, ...metadata }) => ({
  name,
  uri: `playmat://guides/${name}`,
  metadata: { ...metadata, mimeType },
  text: readFileSync(new URL(`../guides/${name}.md`, import.meta.url), 'utf8'),
}));

export const guideInstructions = [
  'Use resources/list and resources/read to load Playmat’s guides. Before joining a match, read the match and turn planning guides.',
  ...guides.map(({ uri, metadata }) => `${uri} — ${metadata.description}`),
].join('\n');

export function registerGuides(mcp) {
  for (const { name, uri, metadata, text } of guides) {
    mcp.registerResource(name, uri, metadata, async () => ({ contents: [{ uri, mimeType, text }] }));
  }
}
