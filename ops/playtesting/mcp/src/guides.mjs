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

export const guideBootstrap = 'Before creating, joining or playing a match, load all four guides with get_guide: getting-started, turn-planning, card-catalog and rules (one call per guideId). Repeat after losing conversation context. Listing guides alone does not load their contents.';

export const sequenceInstructions = 'Prefer play_turn: plan significant plays, targets, chosen resources, guarded costs and attacks as one complete public-information turn. The MCP inserts legal ordinary passes between intentions; do not predict exact priority windows or send pass after each expected own resolution. Known initial own stack objects and exact declared casts/triggers may resolve, while rival non-pass actions, new information, chosen stops and unknown mandatory choices interrupt. Opposing Ward requires its separate exact public target-derived expectation and guarded own cost, never permission to act for the rival. Auto-selected targets skip only with exact public spell-target proof. Zero mana never means no useful legal play: free/alternate-cost spells and useful abilities still stop final advance. pace is optional and bounded. Legacy play_sequence returns turn_changed across a turn boundary and never treats land drops as ignorable responses. Legacy play_sequence and standalone pass_until remain distinct: the latter deliberately declines optional responses, while guarded plans retain causal checks. END_TURN is an end-step name; use finish next_turn for the safe no-useful-play advance. Read get_sequence_status and a fresh state after interruptions; never repeat acknowledged actions or reveal hidden information.';

export const guideInstructions = [
  guideBootstrap,
  'Keep the live decision loop active: null secondsRemaining is not unlimited decision time. It is a sampled cumulative match clock, separate from timing.inactivity. Use the server response-inactivity deadline when status is running; zero requires immediate attention, and unknown/null never means unlimited time. Resolve pending legal choices promptly; polling, chat, resync and webhook subscriptions do not answer or renew them. Inspect the state returned even after a wait timeout.',
  'Call get_guide with no arguments to list the guides, then pass guideId to read one. You can also use resources/list and resources/read.',
  sequenceInstructions,
  ...guideList.map(({ uri, description }) => `${uri} — ${description}`),
].join('\n');

export function registerGuides(mcp) {
  for (const { name, uri, text, ...metadata } of guides) {
    mcp.registerResource(name, uri, metadata, async () => ({ contents: [{ uri, mimeType, text }] }));
  }
  mcp.registerTool('get_guide', {
    description: `Discover Playmat’s guides or read one by ID. ${guideBootstrap}`,
    inputSchema: { guideId: GuideId.optional().describe('Omit to list every guide, or choose one ID to read its Markdown.') },
    annotations: { readOnlyHint: true, openWorldHint: false },
    _meta: { securitySchemes: [{ type: 'oauth2', scopes: [] }] },
  }, async ({ guideId }) => {
    const result = guideId === undefined ? { guides: guideList } : guides.find(({ name }) => name === guideId);
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  });
}
