import { z } from 'zod';

const Id = z.string().min(1).max(80);
const Turn = z.number().int().min(1).max(200);
const Integer = z.number().int().nonnegative();
const Color = z.enum(['W', 'U', 'B', 'R', 'G', 'C']);
const Cost = z.object({ pips: z.array(Color).max(16), generic: Integer.max(20) });
const Expression = z.json().describe('A declarative predicate. Use operators such as has_card, land_count, can_cast_by_turn, line_executable, all, any, or not.');
const Card = z.object({
  id: Id,
  name: z.string().min(1).max(200).optional().describe('Printed name from the authorized frame when anchoring a position. Defaults to id.'),
  count: Integer.max(250),
  tags: z.array(Id).max(16).optional(),
  land: z.object({ colors: z.array(Color).min(1).max(6), entersTapped: z.boolean().optional() }).optional(),
  cost: Cost.optional(),
});
const Position = z.object({
  turn: Turn, hand: z.array(Id).max(30),
  lands: z.array(z.object({ id: Id, tapped: z.boolean() })).max(20),
  canPlayLand: z.boolean().optional(),
  knownPositions: z.array(z.object({ index: Integer, id: Id })).max(250).optional(),
  shuffleRanges: z.array(z.object({ start: Integer, count: Integer })).max(8).optional(),
});
const Policy = z.object({
  id: Id, minimumHand: z.number().int().min(5).max(7).optional(),
  keep: Expression.optional(), preferKeep: z.array(Id).max(180).optional(), landOrder: z.array(Id).max(180).optional(),
  line: z.array(z.object({ turn: Turn, cardId: Id, costOverride: Cost.optional() })).max(12).optional(),
});
const Hypothesis = z.object({
  id: Id, assumption: z.string().min(1).max(280), cards: z.array(Card).min(1).max(180),
  response: Expression, disrupts: z.array(Id).min(1).max(20), policy: Policy.omit({ id: true }).optional(),
});
const Study = z.object({
  seed: Integer.max(2 ** 32 - 1), trials: z.number().int().min(1).max(5000).optional(), horizon: Turn, onPlay: z.boolean(),
  cards: z.array(Card).min(1).max(180), position: Position.optional(), policies: z.array(Policy).min(1).max(4),
  queries: z.array(z.object({ key: Id, policy: Id, expression: Expression })).max(20).optional(),
  compare: z.array(z.object({ left: Id, right: Id })).max(10).optional(),
  hypotheses: z.array(Hypothesis).max(4).optional().describe('Named opponent response hypotheses; include caller-provided assumptions.'),
});
const Anchor = z.object({ gameId: z.uuid(), archiveRevision: z.string().regex(/^[a-f0-9]{64}$/),
  cursor: Integer.max(2_147_483_647), seatId: z.string().min(1).max(96) });
const Edge = z.object({ to: Id, action: z.string().min(1).max(180), weight: z.number().min(0).max(1).optional() });
const Node = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('terminal'), scored: z.boolean() }),
  z.object({ kind: z.literal('unknown') }),
  z.object({ kind: z.enum(['max', 'min', 'chance']), complete: z.boolean(), edges: z.array(Edge).min(1).max(80) }),
]);
const Graph = z.object({
  objective: z.literal('lethal_this_turn'), rootId: Id, maxDepth: z.number().int().min(1).max(16),
  budget: z.number().int().min(1).max(10_000), nodes: z.record(Id, Node),
});

const Combat = z.strictObject({
  attackers: z.array(z.strictObject({ id: Id, power: z.number().int().min(-100_000).max(100_000) })).max(20),
  blockers: z.array(z.strictObject({ id: Id, canBlock: z.array(Id).max(20) })).max(20),
  defendingLife: z.number().int().min(1).max(1_000_000),
  replies: z.array(z.strictObject({ id: Id, removeAttackers: z.array(Id).max(20).optional(),
    lifeGain: Integer.max(1_000_000).optional() })).max(20).optional(),
  completeLegalActions: z.boolean().describe('The submitted attackers cover all legal choices for this modeled combat.'),
  completeReplies: z.boolean().describe('The submitted responses and blocker pairs cover all legal replies in the modeled combat.'),
  budget: z.number().int().min(1).max(10_000),
});

export function registerTheorycraftTools(tool, fromProduct) {
  tool('run_theory_study', 'Save a seeded, aggregate study of declared mana lines, queries and policy comparisons. Optional annotation anchors require an authorized, completed replay. Standalone studies use hypothetical data.', {
    study: Study, requestId: z.uuid().optional().describe('Use the same request ID and model to retry safely.'), anchor: Anchor.optional(),
  }, 'history', args => fromProduct('run_theory_study', args));
  tool('get_theory_study', 'Read the saved aggregate result of your theory study. Linked studies require continuing access to their exact archived annotation.', {
    studyId: z.uuid(),
  }, 'history', args => fromProduct('get_theory_study', args), true);
  tool('search_theory_tactics', 'Search for lethal this turn with exactly one input. Submit a decision graph or ordinary combat without special combat-damage abilities. Results apply within the submitted model.', {
    graph: Graph.optional(), combat: Combat.optional(),
  }, 'history', args => fromProduct('search_theory_tactics', args), true);
}
