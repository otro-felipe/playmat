import { z } from 'zod';

const qualityScore = z.number().int().min(0).max(100);
const scoredPosition = z.object({
  index: z.number().int().nonnegative(),
  played: qualityScore,
  best: qualityScore,
  confidence: z.enum(['low', 'medium', 'high']),
  alternative: z.string().trim().min(1).max(200).optional(),
  reason: z.string().trim().min(1).max(600),
}).strict().refine(({ played, best, alternative }) => best >= played && (best === played || Boolean(alternative)),
  'The best score must cover the played line. Name an alternative when it improves on the played line.');

export const scoredPositions = z.array(scoredPosition).max(40);

export function registerMatchReviewPrompt(mcp) {
  mcp.registerPrompt('review_playmat_match', {
    title: 'Review a Thoughtseize game',
    description: 'Compare observed plays against plausible legal alternatives and report accuracy with evidence coverage.',
    argsSchema: { gameId: z.uuid() },
  }, ({ gameId }) => ({
    messages: [{ role: 'user', content: { type: 'text', text: `Review completed Thoughtseize game ${gameId} from the authorized player's perspective.

1. Call evaluate_match for this game. Follow next as the next start offset. Treat pre-action replay positions as evidence. An engine_log position pairs a logged play with the preceding snapshot, so priority may have changed before the play. A frame_delta position infers the play between snapshots. Use only the player's hand at the candidate position, the visible board and stack, and previously revealed information. Mark materially incomplete positions low confidence. Keep future draws, the game result, and unrevealed opponent cards and deck contents out of the analysis.
2. Read the rules guide with get_guide (guideId: rules) or at playmat://guides/rules. Consult get_card for exact card rules when the catalog is available. For each position, compare the played action with up to two legal alternatives whose mana, timing, targets and costs fit the visible position. A pass can be a candidate when legal.
3. For each candidate, consider up to two credible replies the opponent could make from public information. Treat hidden-card replies as possibilities. Include passing or declining to respond when plausible. Compare the worst plausible branch per candidate through the same near-term horizon, such as the next decision after the current stack resolves. Explain the tradeoff using board position, resources, tempo or credible threats.
4. Use the same 0–100 strategic quality scale for played and best in each position. Use 90–100 for strong lines, 70–89 for sound lines, 40–69 for lines with a material drawback, and 0–39 for avoidable major losses. Include the played action among candidates for best. Give an alternative when best exceeds played. Mark unsupported or ambiguous positions low confidence. Submit your reviews, including low-confidence entries, through score_match_evaluation in one request with up to 40 distinct indexes. Low-confidence positions are excluded from accuracy. If more positions are available, sample across the game before choosing scores.
5. Report the score and coverage using scored, reviewed and total. State whether the replay is partial and describe the most important supported improvements. If accuracy is null, say the available evidence cannot support a score. Present accuracy as a review of the sampled decisions under these assumptions.` } }],
  }));
}
