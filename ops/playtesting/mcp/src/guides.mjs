import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { z } from 'zod';

const mimeType = 'text/markdown';
const readGuide = (name) => readFileSync(new URL(`../guides/${name}.md`, import.meta.url), 'utf8').trimEnd();
const glossary = readGuide('glossary');
const matchupStrategy = readGuide('matchup-strategy');
const usesMatchupStrategy = new Set(['card-catalog', 'replay-analysis']);
const guides = [
  {
    name: 'getting-started', title: 'Start a Thoughtseize match',
    description: 'Join with an invite, use engine decisions, sideboard, and follow the table’s chat mode.',
  },
  {
    name: 'card-catalog', title: 'Cards and matchups',
    description: 'Look up cards, validate decks, and estimate responses from public information.',
  },
  {
    name: 'turn-planning', title: 'Play a line',
    description: 'Copy complete play_line examples for casting, costs, triggers, combat and command recovery.',
  },
  {
    name: 'rules', title: 'Magic rules',
    description: 'Find the official downloadable Comprehensive Rules and sections for common timing questions.',
  },
  {
    name: 'player-dispatch', title: 'Assign a player to an approved match',
    description: 'Find an addressed invitation, select an available player and hand off the approved match.',
  },
  {
    name: 'replay-analysis', title: 'Review Magic decisions after the match',
    description: 'Research matchups, reconstruct decisions and grade supported plays and omissions.',
  },
].map(({ name, ...metadata }) => ({
  name, ...metadata, mimeType,
  uri: `playmat://guides/${name}`,
  text: [readGuide(name === 'player-dispatch' ? 'player-dispatch/SKILL' : name), ...(['getting-started', 'replay-analysis'].includes(name) ? [glossary] : []),
    ...(usesMatchupStrategy.has(name) ? [matchupStrategy] : [])].join('\n\n') + '\n',
}));
const GuideId = z.enum(guides.map(({ name }) => name));
const guideList = guides.map(({ text, ...guide }) => guide);
const bootstrapNames = new Set(['getting-started', 'card-catalog', 'turn-planning', 'rules']);
const bootstrapGuides = guides.filter(({ name }) => bootstrapNames.has(name));
const guideBundle = {
  version: createHash('sha256').update(JSON.stringify(bootstrapGuides)).digest('hex'),
  guides: bootstrapGuides,
};
export const replayAnalysisGuide = guides.find(({ name }) => name === 'replay-analysis').text;

export const guideBootstrap = 'Before creating, joining or playing a match, call get_guide({"bundle":true}) to load all four full guides: getting-started, turn-planning, card-catalog and rules. Repeat after losing conversation context. Listing guides alone does not load their contents.';

export const sequenceInstructions = 'Prefer play_line for the longest justified line. Legacy play_sequence and submit_sequence accept guarded engine steps, return turn_changed across a turn boundary and never treat land drops as ignorable responses. The standalone pass_until actively declines optional responses through rival actions in the current turn. Use a guarded line when a rival action should return control. Inspect the legacy sequence receipt and current state after interruptions.';

export const chatInstructions = 'Follow the host chatMode: quiet has no unsolicited commentary; chatty is friendly conversation without tactical coaching. When chatMode is coach, be warm, specific and lightly playful in the player’s language. During the human’s turn, flag at most one genuinely strong opportunity only when current public evidence supports its legal sequence and concrete benefit. After each completed human turn, give one short review: a concretely better alternative and why, judged from what was known before the decision, or a specific, qualified acknowledgement of a reasonable line. If observations are incomplete, say so instead of inventing superiority or praise. Coach mode grants no hand access: do not inspect hidden/debug/private-library data, use your own hidden cards to select advice, or repeat private lookedAt information in chat. Use only public facts or information the human knowingly shared for this coaching audience; unseen draws and later reveals cannot justify hindsight. Resolve your pending engine decision first; commentary never answers, pauses or extends a deadline. Keep it to one to three sentences, avoid repeated reviews after polling/reconnects, and skip unavailable chat without delaying play. Read the coaching procedure in getting-started and apply the same matchup strategy from card-catalog to play and coaching.';

export const guideInstructions = [
  guideBootstrap,
  'Use play_line for the longest justified line from your observed game state. Include known plays, targets, costs, choices and combat together. The executor handles routine priority handoffs. Stop and replan from the returned state on a meaningful opponent action, new information, or an unplanned required choice. Use choose for any visible engine prompt. Pass once deliberately with pass_priority, or use a terminal pass_until with my_upkeep to plan before drawing or my_draw to plan after drawing. The default if_no_play policy stops for legal plays, including free or alternate costs; use decline_optional only as a strategic choice.',
  'Keep the live decision loop active: null secondsRemaining is not unlimited decision time. It is a sampled cumulative match clock, separate from timing.inactivity. Use the server response-inactivity deadline when status is running; zero requires immediate attention, and unknown/null never means unlimited time. Resolve pending legal choices promptly; polling, chat, resync and webhook subscriptions do not answer or renew them. Inspect the state returned even after a wait timeout.',
  'Use guideId to read one guide. Clients with native resource support can read the equivalent resources.',
  chatInstructions,
  'In chatty matches, greet the opposing pilot and reply naturally to their table messages. Use wait_for_chat alongside play_line or wait_for_decision with its own chat cursor. With sequential-only tools, look for chatCursor and call list_chat. Send messages to the rival with send_chat. A brief play_line reasoning comment goes to the spectator browser and the authorized replay. Agents play from their own seat.',
  'An absent or unknown chatMode means quiet. Never carry Coach advice over to another table without its host choosing it.',
  ...guideList.map(({ uri, description }) => `${uri} — ${description}`),
].join('\n');

export function registerGuides(mcp) {
  for (const { name, uri, text, ...metadata } of guides) {
    mcp.registerResource(name, uri, metadata, async () => ({ contents: [{ uri, mimeType, text }] }));
  }
  mcp.registerTool('get_guide', {
    description: `Read the complete Thoughtseize guide bundle, a single guide, or the guide index. ${guideBootstrap}`,
    inputSchema: {
      bundle: z.boolean().optional().describe('Set true to read all four full guides and their shared version in one call.'),
      guideId: GuideId.optional().describe('Read one guide by ID. Omit both inputs to list the guide index.'),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    _meta: { securitySchemes: [{ type: 'oauth2', scopes: [] }] },
  }, async ({ bundle, guideId }) => {
    if (bundle && guideId !== undefined) {
      return { isError: true, content: [{ type: 'text', text: JSON.stringify({
        code: 'conflicting_guide_selection',
        message: 'Choose the full bundle or a single guide.',
      }) }] };
    }
    const selected = guideId === undefined ? { guides: guideList } : guides.find(({ name }) => name === guideId);
    const result = bundle ? guideBundle : selected;
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  });
}
