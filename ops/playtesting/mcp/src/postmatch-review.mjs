import { z } from 'zod'

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
  rationale: line, benefit: line, risk: line,
  alternatives: z.array(alternative).max(3).optional(),
  opponentResponses: z.array(opponentResponse).max(3).optional(),
  sources: z.array(source).max(4).optional(), retrospective: line.optional(),
}).strict()

export const reviewManifestInput = { matchId: z.uuid().optional(), gameId: z.uuid().optional() }
export const reviewEvidenceInput = {
  ...query, purpose: z.enum(['analysis', 'replay']).default('analysis'),
  scope: z.enum(['seat', 'public', 'full']).default('seat'),
  count: z.number().int().min(1).max(12).optional(),
  includeBefore: z.boolean().optional().describe('Omit before-state payloads from public analysis pages when false.'),
}
export const reviewAnnotationsInput = { ...query, count: z.number().int().min(1).max(24).optional() }
export const saveReviewAnnotationsInput = { gameId: z.uuid(), archiveRevision, entries: z.array(entry).min(1).max(24) }

export function registerPostMatchReviewPrompt(mcp) {
  mcp.registerPrompt('review_playmat_replay', {
    title: 'Review a completed Playmat replay',
    description: 'Analyze every recorded decision by seat, save revisable annotations and report coverage.',
    argsSchema: { gameId: z.uuid() },
  }, ({ gameId }) => ({
    messages: [{ role: 'user', content: { type: 'text', text: `Review completed Playmat game ${gameId}.

1. Call get_match_review with the game ID. Report what the archive actually recorded. For every available acting seat, use read_review_evidence with purpose:analysis and that seat. Follow next until the seat's evidence is exhausted and retain the archive revision. Page list_review_annotations to resume from saved cursors.
2. Judge each recorded action from its preceding position and the information its acting seat had then. Treat an engine_log position as approximate. Compare credible legal alternatives across the same horizon. Consider mana, priority, source, targets, likely matchup responses and tradeoffs. Use get_card and the rules guide for rules. Use curated public format examples for plausible replies without implying a card was in hand. The post-action stack is for playback and cannot justify the grade.
3. Use optional public references only when they matter. Record their public HTTPS URL, date, format and applicability. Search generic rules and public archetype questions. Keep hands, decklists, private annotations and game identifiers out of those queries.
4. Write a concise rationale explaining why the play earned the assessment, then give concrete alternatives and tradeoffs. Exceptional requires a difficult-to-find legal line that delivers material advantage when the credible alternatives leave the player worse off. Optimal describes the best supported line and requires a confirmed legal comparator. Sound, acceptable and equivalent describe reasonable decisions. Small or decisive losses require a confirmed better alternative. Mark incomplete evidence insufficient and ordinary passes trivial.
5. Save every unsaved decision in small batches with save_review_annotations using the archive revision and exact event cursor. Include the current annotation revision when editing. Use the retrospective field only when full permission is available and explain a later observation separately. Read the updated summary. Report counts, confidence and coverage without a percentage score.` } }],
  }))
}
