import { readFileSync } from 'node:fs';
import { z } from 'zod';

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
  name, ...metadata, mimeType,
  uri: `playmat://guides/${name}`,
  text: readFileSync(new URL(`../guides/${name}.md`, import.meta.url), 'utf8'),
}));
const GuideId = z.enum(guides.map(({ name }) => name));
const guideList = guides.map(({ text, ...guide }) => guide);

export const guideInstructions = [
  'Call get_guide with no arguments to list the guides, then pass guideId to read one. You can also use resources/list and resources/read.',
  'Before joining a match, read getting-started and turn-planning.',
  ...guideList.map(({ uri, description }) => `${uri} — ${description}`),
].join('\n');

export function registerGuides(mcp) {
  for (const { name, uri, text, ...metadata } of guides) {
    mcp.registerResource(name, uri, metadata, async () => ({ contents: [{ uri, mimeType, text }] }));
  }
  mcp.registerTool('get_guide', {
    description: 'Discover Playmat’s guides or read one by ID. Read getting-started and turn-planning before joining. Use card-catalog for card lookup and rules for official Magic rules.',
    inputSchema: { guideId: GuideId.optional().describe('Omit to list every guide, or choose one ID to read its Markdown.') },
    annotations: { readOnlyHint: true, openWorldHint: false },
    _meta: { securitySchemes: [{ type: 'oauth2', scopes: [] }] },
  }, async ({ guideId }) => {
    const result = guideId === undefined ? { guides: guideList } : guides.find(({ name }) => name === guideId);
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  });
}
