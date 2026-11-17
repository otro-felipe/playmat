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

export const sequenceInstructions = 'The standalone pass_until tool intentionally declines optional plays through opponent responses; a pass_until step inside play_sequence is guarded and interrupts on unexpected responses/public opponent changes. pass_until actively passes; END_TURN is an end-step name, not a command to wait for your next turn. Sequences stop with turn_changed at a turn boundary. Read get_sequence_status and get_game_state before replanning. Keep skipOptionalResponses false to preserve land drops and other plays. yield_priority deliberately passes exactly once and waits for a new self decision or opponent handoff. allowPlannedResolutions is opt-in and requires continuous public engine evidence for this sequence’s expected own spell/trigger resolutions. Own damage or effects on rival objects are not rival actions; a committed public rival action still interrupts, even in the same update. Plan a complete conditional turn even through open rival mana. Use advance_to_own_turn only when current legal choices offer no useful play, never because mana is zero; it stops before the next own turn or an unexpected choice/action. Use pace only for a brief bounded ordinary-priority beat, never to infer hidden cards from delay.';

export const guideInstructions = [
  guideBootstrap,
  'Keep the live decision loop active: null secondsRemaining is not unlimited decision time. It is a sampled cumulative match clock, separate from the unknown response-inactivity deadline. Resolve pending legal choices promptly; polling, chat and webhook subscriptions do not answer them. Inspect the state returned even after a wait timeout.',
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
