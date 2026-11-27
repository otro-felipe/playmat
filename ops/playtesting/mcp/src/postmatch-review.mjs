import { z } from 'zod'
import { replayAnalysisGuide } from './guides.mjs'

const cursor = z.number().int().min(0).max(2_147_483_647)
const seatId = z.string().trim().min(1).max(80)
const archiveRevision = z.string().trim().min(1).max(128)
const query = {
  gameId: z.uuid(),
  archiveRevision: archiveRevision.optional(),
  cursor: cursor.optional(),
  turn: z.number().int().min(0).max(1_000_000).optional(),
  seatId: seatId.optional(),
}
const line = z.string().trim().min(1).max(900)
const alternative = z.object({
  line, legality: z.enum(['confirmed', 'conditional', 'unverified']), condition: z.string().trim().min(1).max(400).optional(),
  benefit: line, risk: line,
}).strict()
const opponentResponse = z.object({ line, basis: z.enum(['public_observed', 'plausible']), impact: line }).strict()
const source = z.object({
  url: z.string().url().max(400), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  format: z.string().trim().min(1).max(120), applicability: z.string().trim().min(1).max(500),
}).strict()
const entry = z.object({
  cursor, seatId, expectedRevision: z.number().int().min(1).optional(),
  confidence: z.enum(['low', 'medium', 'high']),
  assessment: z.enum(['exceptional', 'optimal', 'sound', 'acceptable', 'small_loss', 'decisive_loss', 'equivalent', 'insufficient', 'trivial']),
  decisionEvidence: z.object({
    observationCursor: cursor, summary: z.string().trim().min(1).max(600),
  }).strict().optional().describe('Concrete observed fact from the pre-action window that supports the comparison.'),
  omission: z.object({
    observedThroughCursor: cursor, opportunityObjectId: z.uuid(),
    window: z.enum(['before_combat', 'before_end_turn']).optional(), openingCursor: cursor.optional(),
  }).strict().optional().describe('Anchor a clearly inferred omission to a priority frame and the recorded end of that window.'),
  rationale: line, benefit: line, risk: line,
  alternatives: z.array(alternative).max(3).optional(),
  opponentResponses: z.array(opponentResponse).max(3).optional(),
  sources: z.array(source).max(4).optional(), retrospective: line.optional(),
}).strict()

export const reviewManifestInput = {
  matchId: z.uuid().optional(), gameId: z.uuid().optional(),
  archiveOnly: z.boolean().optional().describe('Return retained archive status, revision and game quality, including the reason where authorized, without opening replay evidence. Coverage is partial in this mode.'),
}
export const reviewEvidenceInput = {
  ...query, purpose: z.enum(['analysis', 'replay']).default('analysis'),
  scope: z.enum(['seat', 'public', 'full']).default('seat'),
  count: z.number().int().min(1).max(12).optional(),
  includeBefore: z.boolean().optional().describe('Omit before-state payloads from public analysis pages when false.'),
}
export const reviewAnnotationsInput = { ...query, count: z.number().int().min(1).max(24).optional() }
export const saveReviewAnnotationsInput = { gameId: z.uuid(), archiveRevision, entries: z.array(entry).min(1).max(24) }
export const saveGameQualityInput = {
  gameId: z.uuid(), archiveRevision: z.string().regex(/^[a-f0-9]{64}$/), goodQuality: z.boolean(),
  qualityReason: z.string().trim().min(1).max(1200).optional()
    .describe('Short Markdown explanation of the observed finding or missing evidence. Supply qualityAnchor with the reason.'),
  qualityAnchor: z.union([
    z.object({ kind: z.enum(['review_cursor', 'spectator_frame']), cursor }).strict(),
    z.object({ kind: z.enum(['interruption', 'insufficient_evidence']) }).strict(),
  ]).optional().describe('Use the zero-based archive event cursor or the public spectator frame index. Interruption and insufficient evidence require a negative verdict.'),
}

export function registerPostMatchReviewPrompt(mcp) {
  mcp.registerPrompt('review_playmat_replay', {
    title: 'Review a completed Thoughtseize replay',
    description: 'Analyze every recorded decision by seat, save revisable annotations and report coverage.',
    argsSchema: { gameId: z.uuid() },
  }, ({ gameId }) => ({
    messages: [{ role: 'user', content: { type: 'text', text: `Review completed Thoughtseize game ${gameId}.

1. Call get_match_review with the game ID. Page the evidence for both acting seats and retain the archive revision. Use the match ID to inspect authorized public plays from earlier games and the acting seat's own sideboard changes. Page list_review_annotations to read prior grades and their revisions.
2. Apply the guide below to each material decision. Compare credible legal alternatives from the acting seat's knowledge. Use recorded opening choices, revealed-hand decisions and priority receipts. Review a meaningful inferred omission with a bounded observed window when the save schema supports it. Describe what the archive actually shows.
3. Research public matchup patterns when they change the analysis. Include dated public sources, relevant observed cards, the timing of plausible responses, and how the tradeoffs affect the comparison. Keep private match data out of external queries.
4. Give a concise grade, rationale, alternatives and confidence. Reconstruct missing frames from anchored observations when the material choices can be established. Assessments with two reasonable lines can be normal. Exceptional requires an exact, difficult-to-find line with a material advantage over credible alternatives.
5. Save notes in small batches with the archive revision and exact event cursor. Include the current annotation revision when revising. Keep later revelations in the retrospective. Verify coverage in the updated manifest and say which decisions were still ungradable.

${replayAnalysisGuide}` } }],
  }))
}
