import { clientKey, createConcurrencyLimit, createLimits } from '../../product/limits.mjs';
import { createServer } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { humanMatchAccess, seatContext } from './human-matches.mjs';
import { GameSeat, ToolError } from './game-seat.mjs';
import { monitorSeatDecisions, registerEvents } from './events.mjs';
import { listArchetypes, possibleResponses, searchCards } from './catalog.mjs';
import { guideBootstrap, guideInstructions, registerGuides, sequenceInstructions } from './guides.mjs';
import { registerMatchReviewPrompt, scoredPositions } from './match-review.mjs';
import { registerPostMatchReviewPrompt, reviewManifestInput, reviewEvidenceInput, reviewAnnotationsInput, saveReviewAnnotationsInput } from './postmatch-review.mjs';
import { playLine, waitForLine } from './line-runtime.mjs';
import { registerTheorycraftTools } from './theorycraft.mjs';
import { compactGameState, formatGameReceipt } from './state-view.mjs';

const Uuid = z.uuid();
const LibraryDeckId = z.string().regex(/^[a-z0-9_:.-]{1,64}$/i);
const StringId = z.string().min(1).max(120);
const Format = z.enum(['Standard', 'Pioneer', 'Modern']);
const Cursor = z.number().int().nonnegative();
const Value = z.union([z.number().int(), z.array(z.number().int().nonnegative()).max(128)]);
const StateView = z.enum(['full', 'compact']).optional().describe('Use compact for gameplay. A choice cardRef identifies a visible card in the same state. Use full (the default) for inline choice cards and printing details.');
const GameCondition = {
  phase: z.string().min(1).max(32).optional(),
  step: z.string().min(1).max(40).optional(),
  priority: z.enum(['self', 'opponent', 'none']).optional(),
};
const hasDestination = (value) => value.phase !== undefined || value.step !== undefined || value.priority !== undefined;
const Hold = z.object({ kind: z.literal('hold'), delayMs: z.number().int().min(1).max(10_000) }).strict();
const Pace = z.object({ kind: z.literal('pace'), delayMs: z.number().int().min(1).max(1000).describe('Brief ordinary-priority pacing only; actual delay is capped at 250ms when inactivity timing is unknown.') }).strict();
const AdvanceToOwnTurn = z.object({ kind: z.literal('advance_to_own_turn') }).strict();
const ManaColor = z.enum(['W', 'U', 'B', 'R', 'G', 'C']);
const TargetZone = z.enum(['BATTLEFIELD', 'GRAVEYARD', 'EXILED', 'STACK', 'COMMAND', 'ALL']);
const ChoiceSelector = z.object({
  cardName: z.string().trim().min(1).max(250).optional(),
  cardId: StringId.optional(), label: z.string().trim().min(1).max(500).optional(),
  objectId: StringId.optional(),
  abilityId: StringId.optional().describe('Exact engine ID of a visible ability or spell mode.'),
  answer: z.boolean().optional().describe('Boolean engine answer in a question, independent of its button label.'),
  zone: z.enum(['hand', 'battlefield', 'exile', 'graveyard', 'stack']).optional(),
  manaColor: ManaColor.optional(),
}).strict().refine(({ cardName, cardId, objectId, label, abilityId, answer, manaColor }) => cardName || cardId || objectId || label
  || abilityId || answer !== undefined || manaColor, 'Name the exact visible object, card, ability, answer or choice label.');
const OwnTrigger = z.object({ sourceId: StringId, abilityText: z.string().min(1).max(2000), count: z.number().int().min(1).max(4).default(1) }).strict();
const OwnActivation = z.object({ sourceId: StringId, abilityText: z.string().min(1).max(2000) }).strict();
const TargetTrigger = z.object({ sourceId: StringId, targetingCardId: StringId, abilityText: z.string().min(1).max(2000), count: z.number().int().min(1).max(2).default(1) }).strict();
const Answer = z.object({
  kind: z.literal('answer'), choiceId: StringId.optional(), select: ChoiceSelector.optional(), decisionId: StringId.optional(),
  guard: z.object({ kind: StringId, ...GameCondition, instruction: z.string().min(1).max(2000).optional() }).strict().optional(), value: Value.optional(),
  expectCast: z.boolean().default(false),
  expectAbility: OwnActivation.optional().describe('One exact own non-mana activated stack ability from a visible battlefield source; never a rival ability or trigger.'),
  expectTriggers: z.array(OwnTrigger).max(4).optional().describe('Predeclare exact own triggered abilities caused by this answer; never matches opponent abilities.'),
  expectTargetTriggers: z.array(TargetTrigger).max(2).optional().describe('Separate Ward forecast: exact public opposing target, targeting own card and exact Ward trigger text. It never authorizes a rival action.'),
  skipIfTargetedBy: StringId.optional().describe('Skip this target answer only if its exact selected public object is already announced as a target of this own planned card. Never skip a hidden-zone cost.'),
}).strict()
  .refine(({ choiceId, select }) => !!choiceId !== !!select, 'Use one exact choice ID or one semantic selector.')
  .refine((value) => value.decisionId || (value.guard && (hasDestination(value.guard) || value.guard.instruction !== undefined)),
  'Use the observed decisionId, or a guard with its expected kind and destination/exact instruction.');
const YieldPriority = z.object({
  kind: z.literal('yield_priority'), until: z.enum(['self', 'opponent']).default('self').describe('Pass exactly once, then wait for a new self decision or the observed opponent handoff.'),
  allowPlannedResolutions: z.boolean().default(false).describe('Authorize this plan’s exact declared spell/trigger resolutions, including early automatic resolution. Unexpected objects, rival actions and new information still interrupt.'),
}).strict();
const PassUntil = z.object({
  kind: z.literal('pass_until').describe(sequenceInstructions), ...GameCondition,
  stackEmpty: z.literal(true).optional().describe('Require an empty stack in addition to other destination conditions.'),
  allowPlannedResolutions: z.boolean().default(false).describe('Authorize this plan’s exact declared spell/trigger resolutions, including early automatic resolution. Unexpected objects, rival actions and new information still interrupt.'),
  skipOptionalResponses: z.boolean().default(false).describe('Keep false unless intentionally declining every optional play, including land drops. Never use this to wait for your next turn.'),
}).strict().refine((value) => hasDestination(value) || value.stackEmpty === true, 'A pass needs a phase, step, priority or empty-stack destination.');
const Sequence = { gameId: Uuid, cursor: Cursor, expectedStackIds: z.array(StringId).max(16).optional(), allowPlannedCombatDamage: z.boolean().default(false), steps: z.array(z.union([Hold, Pace, Answer, PassUntil, YieldPriority, AdvanceToOwnTurn])).min(1).max(32) };
const Payment = z.union([StringId, z.object({
  sourceId: StringId,
  abilityId: StringId.optional(),
  color: ManaColor.optional(),
}).strict()]).describe('Source object ID, or select an exact legal mana ability or color at that source.');
const DecisionGuard = z.object({
  kind: StringId, instruction: z.string().min(1).max(2000).optional(), ...GameCondition,
  sourceObjectId: StringId.optional().describe('Visible source object ID for a question or panel.'),
  targetSourceId: StringId.optional().describe('Visible source object ID for a target or casting-cost prompt.'),
  targetZone: z.enum([...TargetZone.options, 'HAND']).optional().describe('Exact projected zone, including HAND for a cost choosing a known card from your hand.'),
  targetRole: z.number().int().nonnegative().max(32).optional(),
  modePicker: z.literal(true).optional(),
}).strict();
const PlannedTargets = z.array(z.object({ select: ChoiceSelector, instruction: z.string().min(1).max(2000).optional(),
  targetZone: TargetZone.optional(), role: z.number().int().nonnegative().max(32).optional()
    .describe('Zero-based target role from the engine. Supply a role or exact target instruction.'),
}).strict()).max(8).describe('Known targets in engine prompt order, using visible object IDs.');
const TurnActivation = z.object({
  kind: z.literal('activate'),
  sourceId: StringId.describe('Visible battlefield object ID of your permanent.'),
  abilityId: StringId.describe('Exact engine ability ID from this source’s nonManaAbilities in the priority choice.'),
  abilityText: z.string().min(1).max(2000).describe('Full public ability rule text for verifying the stack object.'),
  when: z.enum(['stack_empty', 'priority']).default('stack_empty'),
  targets: PlannedTargets.optional().describe('Exact legal target selectors with their role or prompt guard.'),
  payWith: z.array(Payment).max(16).optional(),
  reevaluateAfter: z.boolean().optional(),
  expectTriggers: z.array(OwnTrigger).max(4).optional(),
}).strict();
const TurnPlayShape = z.object({ kind: z.literal('play'), select: ChoiceSelector, when: z.enum(['stack_empty', 'priority']).default('stack_empty'),
  playAs: z.literal('land').optional().describe('Require an engine-confirmed land play. If the object opens a picker, use the unique land option for that exact source. Omit for other plays.'),
  reevaluateAfter: z.boolean().optional().describe('Make this the last strategic intention and return control after settlement. Only guarded costs for its tracked cast/activation may follow before resolution; an untracked no-stack choice must be last. Use for uncertain effects not recognized automatically.'),
  expectCast: z.boolean().optional().describe('False for an intentional no-stack special action such as plot; lands are detected automatically. Unexpected stack additions still stop.'),
  spellAbilityId: StringId.optional().describe('Choose this exact spell or alternative-cost ability from the selected source picker.'),
  modeId: StringId.optional().describe('Choose this exact engine option ID for a mode or typed cast face of the selected spell.'),
  mode: z.string().trim().min(1).max(2000).optional().describe('Exact visible mode option text, cast option label, or printed spell face name.'),
  targets: PlannedTargets.optional(),
  payWith: z.array(Payment).max(16).optional(),
  expectTriggers: z.array(OwnTrigger).max(4).optional(), expectTargetTriggers: z.array(TargetTrigger).max(2).optional(),
}).strict();
const TurnPlay = TurnPlayShape.refine(({ playAs, expectCast, targets, payWith, spellAbilityId, modeId, mode }) => playAs !== 'land'
  || (expectCast !== true && !targets?.length && !payWith?.length && !spellAbilityId && !modeId && !mode),
'A land action cannot include spell targets, casting mana or a spell forecast.')
  .refine(({ modeId, mode }) => !(modeId && mode), 'Use either a mode ID or exact mode text.');
const TurnChooseShape = z.object({ kind: z.literal('choose'),
  choiceId: StringId.optional().describe('Copy the id of a legal option from decision.choices. Pair it with the observed decisionId.'),
  select: ChoiceSelector.optional().describe('For a planned prompt, uniquely identify the legal option by object ID or exact option label.'),
  decisionId: StringId.optional().describe('Copy decision.id from the same observed state as the choice.'),
  guard: DecisionGuard.optional(),
  adoptTriggerOrder: z.literal(true).optional().describe('Follow the exact visible trigger selected from a trigger-order prompt and the final forced option when two remain. Confirm both on the stack before resolving.'),
  value: Value.optional(), reevaluateAfter: z.boolean().optional(), expectCast: z.boolean().optional(), expectAbility: OwnActivation.optional(), skipIfTargetedBy: StringId.optional(), expectTriggers: z.array(OwnTrigger).max(4).optional(), expectTargetTriggers: z.array(TargetTrigger).max(2).optional(),
}).strict();
const TurnChoose = TurnChooseShape.refine(({ choiceId, select }) => !!choiceId !== !!select, 'Use one exact choiceId or one semantic select, as with submit_decision.')
  .refine(({ decisionId, guard, select }) => decisionId || guard && (
    ['priority', 'payMana'].includes(guard.kind) || guard.instruction !== undefined
    || guard.kind === 'panel' && (guard.sourceObjectId || guard.modePicker) && (select?.abilityId || select?.manaColor)
    || guard.kind === 'question' && guard.sourceObjectId && select?.answer !== undefined
    || guard.kind === 'target' && guard.targetSourceId && guard.targetRole !== undefined && select?.objectId
  ), 'Use the observed decisionId, or guard a future mandatory choice with exact instruction or typed source and option.');
const TurnAttackShape = z.object({ kind: z.literal('attack'), attackers: z.union([z.literal('all'), z.array(StringId).max(16)]).optional(),
  assignments: z.array(z.object({ attackerId: StringId, defenderId: StringId }).strict()).max(16)
    .optional().describe('Exact visible attacker–defender pairs. A defender can be a player, planeswalker or battle. Supply assignments or attackers.'),
  expectTriggers: z.array(OwnTrigger).max(4).optional() }).strict();
const TurnAttack = TurnAttackShape.refine(({ attackers, assignments }) => attackers === undefined || assignments === undefined,
  'Supply either attackers or exact assignments.')
  .refine(({ attackers, assignments }) => {
    const ids = assignments?.map(({ attackerId }) => attackerId) ?? (Array.isArray(attackers) ? attackers : []);
    return new Set(ids).size === ids.length;
  }, 'Name each attacker once.');
const TurnBlockShape = z.object({ kind: z.literal('block'),
  assignments: z.array(z.object({ blockerId: StringId, attackerId: StringId }).strict()).max(16)
    .describe('Exact visible blocker–attacker pairs to confirm. An empty list declares no blockers.'),
}).strict();
const TurnBlock = TurnBlockShape.refine(({ assignments }) => new Set(assignments.map(({ blockerId }) => blockerId)).size === assignments.length,
  'Name each blocker once. Use the live engine decision for a creature that can block multiple attackers.');
const Turn = { gameId: Uuid, cursor: Cursor, actions: z.array(z.union([TurnPlay, TurnActivation, TurnChoose, TurnAttack, TurnBlock, Pace])).max(32),
  expectedStackIds: z.array(StringId).max(16).optional(), finish: z.enum(['next_turn', 'end_step', 'none']).default('next_turn') };
const LinePassUntilShape = z.object({
  kind: z.literal('pass_until'),
  destination: z.enum(['my_upkeep', 'my_draw', 'end_step', 'current_turn']).describe('Next own upkeep, forthcoming own draw (including this turn from upkeep), this turn’s end step, or an explicit current-turn condition. A skipped window or missing draw returns the observed state.'),
  policy: z.enum(['if_no_play', 'decline_optional']).default('if_no_play').describe('Decline optional plays only when explicitly intended, for example to bluff a response. Both policies stop on an opponent action, new information or an unplanned required choice.'),
  ...GameCondition,
}).strict();
const LinePassUntil = LinePassUntilShape.refine((value) => (value.destination === 'current_turn') === hasDestination(value),
  'Use phase, step or priority only with current_turn. At least one condition is required for current_turn.');
const LinePassPriority = z.object({ kind: z.literal('pass_priority') }).strict()
  .describe('Deliberately pass once and return at the next actionable boundary.');
const LineActions = z.array(z.discriminatedUnion('kind', [TurnPlay, TurnActivation, TurnChoose, TurnAttack, TurnBlock, Pace, LinePassUntil, LinePassPriority])).min(1).max(32);
const Line = {
  gameId: Uuid, cursor: Cursor, commandId: StringId.describe('Choose a unique ID for this line. For an uncertain result, reuse this ID with the same game, cursor and actions.'),
  reasoning: z.string().trim().min(1).max(600).optional().describe('A brief comment for the live spectator audience and authorized replay. Describe the line’s objective and an observation. Use send_chat to speak to the opponent.'),
  actions: z.array(z.union([TurnPlayShape, TurnActivation, TurnChooseShape, TurnAttackShape, TurnBlockShape, Pace, LinePassUntilShape, LinePassPriority])).min(1).max(32)
    .describe('Plan as far as current information justifies. Use exact choices for visible engine prompts. Put pass_until or pass_priority last.'),
  expectedStackIds: z.array(StringId).max(16).optional().describe('Exact objects already visible on the stack. For a current trigger-order prompt, use choose.adoptTriggerOrder instead.'),
  waitMs: z.number().int().min(0).max(25_000).default(5_000).describe('Bound how long this call waits for the result. If the plan still owns execution, wait_for_decision with this gameId and commandId.'),
  view: StateView,
};
const Catalog = {
  format: Format.optional(), query: z.string().trim().min(1).max(160).optional(),
  colors: z.array(z.enum(['W', 'U', 'B', 'R', 'G', 'C'])).min(1).max(6).optional(),
  minManaValue: z.number().int().min(0).max(30).optional(),
  maxManaValue: z.number().int().min(0).max(30).optional(),
  manaSymbols: z.array(z.string().min(1).max(8)).max(12).optional(),
  types: z.array(z.enum(['ARTIFACT', 'BATTLE', 'CREATURE', 'ENCHANTMENT', 'INSTANT', 'KINDRED', 'LAND', 'PLANESWALKER', 'SORCERY'])).max(9).optional(),
  keywords: z.array(z.string().trim().min(1).max(40)).max(12).optional(),
  offset: z.number().int().min(0).max(40_000).default(0), limit: z.number().int().min(1).max(50).default(25),
};
const DeckCard = z.object({
  cardName: z.string().min(1).max(250), setCode: z.string().max(12).optional(),
  cardNumber: z.string().max(20).optional(), amount: z.number().int().min(1).max(250),
}).strict();
const Deck = z.object({
  name: z.string().min(1).max(120), cards: z.array(DeckCard).min(1).max(250),
  sideboard: z.array(DeckCard).max(40).default([]),
}).strict();

function textResult(value, isError = false) {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], isError };
}

function rejectedLine({ gameId, cursor, commandId, view }, rejection) {
  return formatGameReceipt({
    status: 'rejected', gameId, cursor, commandId,
    actionIndex: null, appliedDecisions: 0, planOwnsExecution: false, ...rejection,
  }, view);
}

function lineArgumentRejection(args, error) {
  const issues = error.issues.map(({ path, code, message }) => ({ path: ['actions', ...path], code, message }));
  const issue = issues[0];
  return rejectedLine(args, {
    stage: 'schema', code: 'invalid_line_arguments', message: issue.message, issues,
    actionIndex: Number.isInteger(issue.path[1]) ? issue.path[1] : null, recovery: 'correct_arguments',
  });
}

function reply(res, status, code, message) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }));
}

function readToken(req) {
  return /^Bearer ([0-9A-Za-z._~+\/=-]{1,256})$/i.exec(req.headers.authorization ?? '')?.[1] ?? null;
}

function registerTools(mcp, { actor, getSeat, callProduct, reauthorize, allowedOrigins, human }) {
  function tool(name, description, inputSchema, scope, run, readOnlyHint = false) {
    if (['create_game', 'join_game', 'start_match', 'get_game_state', 'submit_decision', 'pass_until', 'advance_to_own_turn', 'play_sequence', 'submit_sequence', 'play_turn', 'play_line'].includes(name)) {
      description += ` ${guideBootstrap}`;
    }
    if (['play_sequence', 'submit_sequence'].includes(name)) description += ` ${sequenceInstructions}`;
    const scopes = scope === 'catalog' ? ['play', 'library'] : [scope === 'decks' ? 'library' : scope];
    const gameTool = ['play', 'chat'].includes(scope) && (Object.hasOwn(inputSchema, 'gameId')
      || ['list_recoverable_matches', 'get_recovery_status', 'recover_match'].includes(name));
    if (gameTool) inputSchema = { ...inputSchema,
      humanTableId: Uuid.optional().describe('Supply the opted-in table ID on every call for the Human Player. Omit to use the MCP Player.') };
    mcp.registerTool(name, { description, inputSchema, annotations: { readOnlyHint },
      _meta: { securitySchemes: scopes.map(value => ({ type: 'oauth2', scopes: [value] })) },
    }, async (args, extra) => {
      try {
        if (!actor.scopes.includes(scope)) throw new ToolError('forbidden', 'This credential lacks the required scope.');
        const { humanTableId, ...input } = args;
        const execute = async () => {
          const result = await run(gameTool ? input : args, extra.signal);
          if (actor.scopes.includes('chat') && ['get_game_state','wait_for_decision','play_line'].includes(name)) {
            const cursor = getSeat().engine.chatCursor?.(result.gameId ?? result.state?.gameId);
            if (cursor) return { ...result, chatCursor: cursor };
          }
          return result;
        };
        const result = humanTableId && gameTool ? await human.select(humanTableId, execute) : await execute();
        const response = textResult(result);
        // Rejected gameplay commands are application receipts. They carry a code,
        // stage and recovery instructions even through clients that normalize MCP errors.
        if (result?.status === 'rejected' && ['play_line', 'wait_for_decision'].includes(name)) {
          response.structuredContent = result;
        }
        return response;
      } catch (error) {
        if (error instanceof ToolError) {
          const receipt = { code: error.code, message: error.message, ...(error.state ? { state: error.state } : {}) };
          return textResult(formatGameReceipt(receipt, args.view), true);
        }
        if (extra.signal.aborted) return textResult({ code: 'cancelled', message: 'The request was cancelled.' }, true);
        return textResult({ code: 'operation_failed', message: 'Thoughtseize could not verify completion. Read the latest state before retrying.' }, true);
      }
    });
  }

  const fromProduct = (operation, args) => {
    if (!callProduct) throw new ToolError('unavailable', 'The product service is unavailable.');
    return callProduct(operation, args);
  };
  tool('get_game_state', 'Read the public battlefield and your own seat, hand, current decision and timing. secondsRemaining is a last reported cumulative match clock, not an inactivity countdown. A null clock or unknown inactivity deadline never means unlimited decision time; answer pending legal choices promptly.', { gameId: Uuid.optional(), view: StateView },
    'play', ({ gameId, view }) => view === 'compact' ? compactGameState(getSeat().snapshot(gameId)) : getSeat().snapshot(gameId), true);
  tool('list_recoverable_matches', 'List matches reserved to this exact account or agent grant, with stable participant links and confirmed boundaries.', {},
    'play', () => getSeat().engine.recoveryList(), true);
  tool('get_recovery_status', 'Read only the confirmed recovery boundary and current engine ID mapping; no hidden checkpoint state.', { matchId: Uuid },
    'play', ({ matchId }) => getSeat().engine.recoveryStatus(matchId), true);
  tool('recover_match', 'Explicitly agree to replay from the displayed durable boundary. Both original participants must agree and reconnect before clocks run. Read status first.', {
    matchId: Uuid, revision: z.number().int().positive(), agree: z.boolean(),
  }, 'play', (args) => getSeat().engine.recoveryJoin(args));
  tool('resync_game', 'Ask XMage for the current decision after a lost or uncertain acknowledgement.', { gameId: Uuid },
    'play', ({ gameId }) => getSeat().engine.resync(gameId));
  tool('wait_for_decision', 'Wait for an engine decision, rollback vote, sideboarding or game end. Use gameId and commandId together for a running line, without cursor or decision filters. A pending rollback returns immediately and takes priority. A timeout includes the current state. Waiting does not answer prompts or pause inactivity.', {
    gameId: Uuid.optional().describe('Required with commandId. Use the gameId from the line receipt.'),
    afterDecisionId: StringId.optional().describe('Ordinary wait only. Wait for a decision with a different ID. Omit with commandId.'),
    afterCursor: Cursor.optional().describe('Ordinary wait only. Wait beyond the last observed cursor. Omit with commandId.'),
    commandId: StringId.optional().describe('Wait for this gameId and commandId from play_line. Omit afterCursor and afterDecisionId.'),
    timeoutMs: z.number().int().min(100).max(25_000).optional(), view: StateView,
  }, 'play', async (args, signal) => {
    if (args.commandId === undefined) return formatGameReceipt(await getSeat().wait(args, signal), args.view);
    const invalidField = !args.gameId ? 'gameId' : args.afterCursor !== undefined ? 'afterCursor'
      : args.afterDecisionId !== undefined ? 'afterDecisionId' : null;
    if (invalidField) {
      const message = 'Use the gameId and commandId from play_line together. Omit afterCursor and afterDecisionId when waiting for that line.';
      return {
        status: 'rejected', stage: 'schema', code: 'invalid_line_wait', message,
        commandId: args.commandId, recovery: 'correct_arguments', issues: [{ path: [invalidField], code: 'custom', message }],
      };
    }
    return formatGameReceipt(await waitForLine(getSeat(), args, signal), args.view);
  }, true);
  tool('wait_until', 'Observe a phase, step or priority destination without passing or modifying play.', {
    gameId: Uuid, ...GameCondition, afterCursor: Cursor.optional(),
    timeoutMs: z.number().int().min(100).max(25_000).optional(),
  }, 'play', (args, signal) => {
    if (!hasDestination(args)) throw new ToolError('missing_destination', 'Choose a phase, step or priority destination.');
    return getSeat().wait(args, signal, args);
  }, true);
  tool('submit_decision', 'Apply one visible choice for the current decision once. Use a new idempotency key for a different decision.', {
    gameId: Uuid, cursor: Cursor.optional(), decisionId: StringId, choiceId: StringId, idempotencyKey: StringId, value: Value.optional(),
  }, 'play', (args) => getSeat().submit(args));
  tool('pass_until', 'Intentionally decline all optional plays until a destination in the observed turn. Continues through opponent responses, but never answers mandatory prompts or crosses turns. Use play_sequence for a guarded line that returns control on a response.', {
    gameId: Uuid, cursor: Cursor, ...GameCondition,
  }, 'play', (args) => {
    if (!hasDestination(args)) throw new ToolError('missing_destination', 'Choose a phase, step or priority destination.');
    const { gameId, cursor, ...destination } = args;
    return getSeat().startSequence({ gameId, cursor,
      steps: [{ kind: 'pass_until', ...destination, skipOptionalResponses: true }],
    }, reauthorize, 'ignore');
  });
  tool('advance_to_own_turn', 'Pass only when the current engine offers no non-mana optional play, stopping before your next turn or any useful legal play, mandatory decision, public opponent action or missing causal evidence. Zero mana is never evidence that no action exists.', { gameId: Uuid, cursor: Cursor },
    'play', ({ gameId, cursor }) => getSeat().startSequence({ gameId, cursor, steps: [{ kind: 'advance_to_own_turn' }] }, reauthorize));
  const playSequence = (args) => getSeat().startSequence(args, reauthorize);
  tool('play_line', 'Submit the longest justified line of plays, activations, choices, attacks and passes from the current cursor, on either turn. Ordinary handoffs are automatic. The line stops on new information, rival actions or a required choice it cannot answer. Returns applied progress and seat-visible game state. Check status, code and recovery when a line is rejected. For an exact choice use its current decisionId and choiceId. Read the turn-planning guide for complete JSON examples, including two targets, Ward, activation, combat and command recovery.', Line, 'play', async (args, signal) => {
    const actions = LineActions.safeParse(args.actions);
    if (!actions.success) return lineArgumentRejection(args, actions.error);
    try {
      return formatGameReceipt(await playLine(getSeat(), { ...args, actions: actions.data }, reauthorize, signal), args.view);
    } catch (error) {
      if (!(error instanceof ToolError) || !error.lineRejection) throw error;
      return rejectedLine(args, {
        stage: 'preflight', code: error.code, message: error.message, recovery: error.lineRejection,
        actionIndex: error.actionIndex ?? null, ...(error.state ? { state: error.state } : {}),
      });
    }
  });
  tool('play_turn', 'Plan a complete turn with significant plays, public targets, chosen mana sources, guarded costs/choices and attacks. The executor makes legal ordinary passes between intentions; do not enumerate passes or predict priority windows. Own declared spells/triggers and the initial own stack may resolve; real rival actions, new information, unknown mandatory choices and chosen stops interrupt. finish next_turn advances only while no useful legal action remains, never because mana is zero.', Turn, 'play', (args) => getSeat().startTurn(args, reauthorize));
  tool('play_sequence', 'Queue guarded choices by exact ID, card or label. Mark a planned cast with expectCast to let later steps pay for that same spell.', Sequence, 'play', playSequence);
  tool('submit_sequence', 'Start a conditional, bounded sequence of choices, brief waits and ordinary passes.', Sequence, 'play', playSequence);
  tool('get_sequence_status', 'Check progress and interruption for your plan. If transport lost its returned ID, recover with the exact startCursor submitted with that plan; inspect accepted counts and state before retrying any action.', { gameId: Uuid, sequenceId: Uuid.optional(), startCursor: Cursor.optional() }, 'play',
    (args) => getSeat().sequenceStatus(args), true);
  tool('cancel_sequence', 'Cancel unapplied steps without undoing moves already accepted by XMage.', { gameId: Uuid, sequenceId: Uuid }, 'play',
    (args) => getSeat().cancelSequence(args));

  const agentRuntime = {
    model: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9.:/_+-]{0,95}$/).optional().describe('Your actual playing model ID if known.'),
    reasoningEffort: z.string().regex(/^[a-z][a-z0-9_-]{0,23}$/).optional().describe('Your configured reasoning effort if known, such as high.'),
  };
  tool('list_joinable_games', 'List only tables with an available invitation for this account.', { limit: z.number().int().min(1).max(50).default(25) },
    'play', (args) => fromProduct('list_joinable_games', args), true);
  const playDeck = {
    deck: Deck.optional(),
    deckId: LibraryDeckId.optional().describe('ID from list_decks. Supply this or an inline deck.'),
  };
  async function resolvePlayDeck(deck, deckId, library = 'agent') {
    if (Boolean(deck) === Boolean(deckId)) throw new ToolError('invalid_deck', 'Choose one library deck ID or supply an inline deck.');
    if (!deckId) return deck;
    const saved = await fromProduct('get_deck', { deckId });
    if (saved?.id !== deckId || saved.library !== library || !saved.data) {
      throw new ToolError('deck_unavailable', 'Choose a saved deck from the playing seat’s library.');
    }
    const { name, cards, sideboard } = saved.data;
    return { name, cards, sideboard, libraryDeckId: deckId };
  }
  tool('list_human_matches', 'Find your waiting or in-progress opted-in Human Player tables, including browser-created tables. Returns tableId and live XMage status.', {}, 'play', () => {
    human.requireAccount();
    return fromProduct('list_human_matches', {});
  }, true);
  tool('list_human_decks', 'List personal decks that can be selected for a Human Player match.', {}, 'decks', () => {
    human.requireAccount();
    return fromProduct('list_human_decks', {});
  }, true);
  tool('create_human_match', 'Create an unrated match as the signed-in Human Player. MCP and friend matches wait for a guest and start_match. Practice and bot start immediately. humanMcpAllowed opts just this table into MCP gameplay.', {
    mode: z.enum(['mcp', 'friend', 'practice', 'bot']), format: Format, name: z.string().trim().min(1).max(80),
    deck: Deck.optional(), deckId: LibraryDeckId.optional(),
    humanMcpAllowed: z.boolean().default(false), winsNeeded: z.union([z.literal(1), z.literal(2)]).default(1),
    guestEngineName: z.string().trim().min(1).max(36).optional().describe('Optional registered guest in friend mode. Omit for an unlisted friend link.'),
    chatMode: z.enum(['quiet', 'chatty', 'coach']).optional().describe('MCP opponent only.'),
    botDeck: Deck.optional().describe('Bot opponent deck. Defaults to a mirror of the human deck.'),
  }, 'play', async ({ mode, format, name, deck, deckId, humanMcpAllowed, winsNeeded, guestEngineName, chatMode, botDeck }) => {
    human.requireAccount();
    if (guestEngineName && mode !== 'friend' || chatMode && mode !== 'mcp' || botDeck && mode !== 'bot') {
      throw new ToolError('invalid_input', 'Opponent options must match the selected game mode.');
    }
    const register = ['mcp', 'friend'].includes(mode) ? record => fromProduct('create_human_invitation', {
      ...record, mode, ...(guestEngineName ? { guestEngineName } : {}), ...(chatMode ? { chatMode } : {}),
    }) : undefined;
    return human.create({ mode, format, name, humanMcpAllowed, winsNeeded, botDeck,
      deck: await resolvePlayDeck(deck, deckId, 'personal') }, register);
  });
  tool('create_game', 'Create a private, unrated best-of-three table as this agent seat.', {
    format: Format, name: z.string().trim().min(1).max(80), ...playDeck,
    guestEngineName: z.string().trim().min(1).max(36), ...agentRuntime,
  }, 'play', async ({ guestEngineName, model, reasoningEffort, deck, deckId, ...args }) => getSeat().engine.createGame({ ...args, deck: await resolvePlayDeck(deck, deckId) },
    (record) => fromProduct('create_game_invite', { ...record, guestEngineName, model, reasoningEffort })));
  tool('join_game', 'Join a private table from its Thoughtseize invite link or table ID. Use a legal deck and an optional seat display name.', {
    tableId: Uuid.optional(), inviteLink: z.url().max(2048).optional(),
    displayName: z.string().trim().min(1).max(24).optional(), ...playDeck, ...agentRuntime,
  }, 'play', async ({ tableId, inviteLink, displayName, model, reasoningEffort, deck, deckId }) => {
      if (Boolean(tableId) === Boolean(inviteLink)) throw new ToolError('invalid_invite', 'Provide either the invite link or the table ID.');
      if (inviteLink) {
        const url = new URL(inviteLink);
        const [, , id] = url.pathname.split('/');
        if (!allowedOrigins.includes(url.origin) || url.username || url.password || url.search || url.hash
          || url.pathname !== `/join/${id}` || !Uuid.safeParse(id).success) {
          throw new ToolError('invalid_invite', 'Provide the private link copied from this Thoughtseize deployment.');
        }
        tableId = id;
      }
      const invitation = await fromProduct('inspect_game_invite', { tableId });
      return getSeat().engine.joinGame({ tableId, deck: await resolvePlayDeck(deck, deckId) }, invitation,
        () => fromProduct('get_game_invite', { tableId, displayName, model, reasoningEffort }));
    });
  tool('start_match', 'Start a ready table as its host. For the MCP Player provide tableId. For the Human Player provide humanTableId, including to finish setup of an MCP-created table with human gameplay disabled.', {
    tableId: Uuid.optional(), humanTableId: Uuid.optional(),
  }, 'play', ({ tableId, humanTableId }) => {
    if (Boolean(tableId) === Boolean(humanTableId)) throw new ToolError('invalid_input', 'Select exactly one host table.');
    return humanTableId ? human.start(humanTableId) : getSeat().engine.startMatch(tableId);
  });
  tool('concede', 'Surrender this game (default) or the whole match explicitly. Cancels the remaining queued plan before sending the concession; accepted earlier actions remain applied.', { gameId: Uuid, entireMatch: z.boolean().default(false) }, 'play',
    ({ gameId, entireMatch }) => { const seat = getSeat(); seat.snapshot(gameId); seat.invalidate('conceded'); return seat.engine.concede(gameId, entireMatch); });
  tool('get_sideboard_state', 'Read the private eligible card pool and state of your sideboarding step.', { gameId: Uuid.optional() }, 'play',
    ({ gameId }) => getSeat().engine.sideboardState(gameId), true);
  tool('submit_sideboard', 'Submit an engine-validated deck drawn from the registered card pool for the next game.', {
    gameId: Uuid.optional(), decisionId: StringId, deck: Deck,
  }, 'play', (args) => getSeat().engine.submitSideboard(args));
  tool('request_rollback', 'Ask the other player to approve a rewind to the start of a turn.', { gameId: Uuid, turnsBack: z.number().int().min(0).max(1) },
    'play', (args) => getSeat().engine.requestRollback(args));
  tool('vote_rollback', 'Vote on the one pending rollback request shown to your seat.', { gameId: Uuid, requestId: Uuid, accept: z.boolean() },
    'play', (args) => getSeat().engine.voteRollback(args));
  tool('list_chat', 'Read recent messages from both players in this game chat. Pass its returned cursor as afterCursor to read only later messages.', {
    gameId: Uuid, afterCursor: Cursor.optional(),
  }, 'chat', ({ gameId, afterCursor }) => getSeat().engine.listChat(gameId, afterCursor), true);
  tool('wait_for_chat', 'Wait for messages from the other seat, independently of a running play_line or decision wait. Start with afterCursor 0, then reuse the chat cursor returned here. Timeout returns an empty list. No game actions are performed.', {
    gameId: Uuid, afterCursor: Cursor.optional(), timeoutMs: z.number().int().min(100).max(25_000).optional(),
  }, 'chat', (args, signal) => getSeat().engine.waitChat(args, signal), true);
  tool('send_chat', 'Send a chat message as this seat in its active match. Follow the host chatMode and the coaching procedure in getting-started. A comment never answers or pauses a pending engine decision; keep play moving and private information out of chat.', {
    gameId: Uuid, message: z.string().trim().min(1).max(500),
  }, 'chat', (args) => getSeat().engine.sendChat(args));

  tool('search_cards', 'Filter the engine catalog by name/text, format, color, mana value or symbols, type and keywords.',
    Catalog, 'catalog', (args) => searchCards(getSeat().engine, args), true);
  tool('get_card', 'Read a known card by name or printing, including mana symbols and rules text.', {
    name: z.string().min(1).max(250), setCode: z.string().max(12).optional(), cardNumber: z.string().max(20).optional(), format: Format.optional(),
  }, 'catalog', (args) => getSeat().engine.getCard(args), true);
  tool('list_archetypes', 'List dated public metagame examples for the selected format.', { format: Format }, 'catalog',
    ({ format }) => listArchetypes(format), true);
  tool('find_possible_responses', 'Suggest possible cards from public archetype examples and catalog filters. The rival list and hand are never queried.', {
    ...Catalog, format: Format, archetype: z.string().trim().min(1).max(120).optional(),
  }, 'catalog', (args) => possibleResponses(getSeat().engine, args), true);
  tool('validate_deck', 'Check the submitted list against XMage constructed rules and card implementation.', { format: Format, deck: Deck }, 'decks',
    (args) => getSeat().engine.validateDeck(args), true);
  tool('list_decks', 'List the reusable MCP opponent decks in your private account library. These appear in the web library under MCP opponent decks.', {}, 'decks', () => fromProduct('list_decks', {}), true);
  tool('get_deck', 'Read one deck in your library.', { deckId: LibraryDeckId }, 'decks', (args) => fromProduct('get_deck', args), true);
  tool('list_deck_archetypes', 'List all predefined library archetypes for the format. Use one label in create_deck and update_deck.', { format: Format },
    'decks', args => fromProduct('list_deck_archetypes', args), true);
  tool('create_deck', 'Save a reusable MCP opponent deck in your private library. It remains available in later sessions and appears under MCP opponent decks on the web.', { name: z.string().min(1).max(120), format: Format, archetype: z.string().min(1).max(150), deck: Deck },
    'decks', (args) => fromProduct('create_deck', args));
  tool('update_deck', 'Save a revision if your current deck revision still matches.', {
    deckId: LibraryDeckId, expectedRevision: z.number().int().positive(), name: z.string().min(1).max(120), format: Format, archetype: z.string().min(1).max(150), deck: Deck,
  }, 'decks', (args) => fromProduct('update_deck', args));
  tool('list_matches', 'List your finished and interrupted matches, filtered by format.', {
    format: Format.optional(), cursor: z.string().max(160).optional(), limit: z.number().int().min(1).max(50).default(25),
  }, 'history', (args) => fromProduct('list_matches', args), true);
  tool('get_match', 'Read one participant-authorized match and its games.', { matchId: Uuid },
    'history', (args) => fromProduct('get_match', args), true);
  const replayPage = { gameId: Uuid, start: Cursor.default(0), count: z.number().int().min(1).max(50).default(25) };
  tool('get_replay', 'Read one redacted replay page from your perspective.', replayPage, 'history',
    (args) => fromProduct('get_replay', args), true);
  tool('query_match_events', 'Read ordered, authorized and cursor-paginated events for one game to analyze its play.', replayPage, 'history',
    (args) => fromProduct('get_replay', args), true);
  tool('evaluate_match', 'Read pre-action evidence for one completed game from the authorized player perspective. Use next as the next page’s start.', {
    gameId: Uuid, start: Cursor.default(0), count: z.number().int().min(1).max(4).default(4),
  }, 'history', (args) => fromProduct('evaluate_match', args), true);
  tool('score_match_evaluation', 'Calculate game accuracy and coverage from reviewed positions. Low-confidence positions are excluded from the score.', {
    gameId: Uuid, positions: scoredPositions,
  }, 'history', (args) => fromProduct('score_match_evaluation', args), true);
  tool('get_match_review', 'Read the match or game review manifest, available perspectives, coverage and saved counts. Supply one matchId or gameId. For qualitative review, read get_guide with guideId replay-analysis or start the review_playmat_replay prompt.',
    reviewManifestInput, 'history', (args) => {
      if (Boolean(args.matchId) === Boolean(args.gameId)) throw new ToolError('invalid_input', 'Supply one matchId or gameId.');
      return fromProduct('get_match_review', args);
    }, true);
  tool('read_review_evidence', 'Read bounded recorded evidence by turn or exact archive cursor. Analysis returns the acting seat’s preceding position and any recorded opening, choice or priority context. Use replay purpose for an authorized retrospective.',
    reviewEvidenceInput, 'history', (args) => fromProduct('read_review_evidence', args), true);
  tool('list_review_annotations', 'Read saved event-linked annotations by game, turn, cursor or authorized seat.',
    reviewAnnotationsInput, 'history', (args) => fromProduct('list_review_annotations', args), true);
  tool('save_review_annotations', 'Persist qualitative annotations on recorded decisions or witnessed inferred omissions. Send the archive revision and the annotation revision when editing. Include a confirmed comparator for an inferred omission or when reconstructing a decision from supporting evidence.',
    saveReviewAnnotationsInput, 'history', (args) => fromProduct('save_review_annotations', args));
  registerTheorycraftTools(tool, fromProduct);
  tool('export_matches', 'Request an authorized download handle for selected games.', {
    gameIds: z.array(Uuid).min(1).max(10),
  }, 'history', (args) => fromProduct('export_matches', args));
}

export function createMcpServer({
  authorize, createEngine, product, eventRequest, publishSeatEvent, oauthResourceMetadata, allowedOrigins = [], maxSeats = 64,
}) {
  const seats = new Map();
  const seatWatchers = new Map();
  const rate = createLimits({
    ingress: { client: 240, total: 2400, window: 60_000 },
    account: { client: 150, total: 2000, window: 60_000 },
  });
  const authSlots = createConcurrencyLimit(32, 8);
  const requestSlots = createConcurrencyLimit(48, 8);
  const server = createServer({ requestTimeout: 30_000, headersTimeout: 10_000 }, async (req, res) => {
    const pathname = req.url?.split('?')[0];
    if (pathname === '/healthz' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
      res.end('ok');
      return;
    }
    if (pathname !== '/mcp') return reply(res, 404, -32601, 'Not found');
    function limited(seconds) {
      res.setHeader('Retry-After', String(seconds));
      return reply(res, 429, -32029, 'Too many MCP requests. Try again shortly.');
    }
    const source = clientKey(req);
    const ingressWait = rate('ingress', source);
    if (ingressWait) return limited(ingressWait);
    const token = readToken(req);
    if (req.headers.origin && !allowedOrigins.includes(req.headers.origin)) return reply(res, 403, -32600, 'Origin not allowed');
    function unauthorized() {
      if (oauthResourceMetadata) res.setHeader('WWW-Authenticate', 'Bearer resource_metadata="' + oauthResourceMetadata + '"');
      return reply(res, 401, -32001, 'Unauthorized');
    }
    if (!token) return unauthorized();

    const releaseAuth = authSlots(source);
    if (!releaseAuth) return limited(2);
    let actor;
    try { actor = await authorize(token); }
    catch { return reply(res, 503, -32000, 'Authorization service unavailable'); }
    finally { releaseAuth(); }
    if (!actor || !actor.accountId || !actor.engineName || !Array.isArray(actor.scopes)) return unauthorized();

    const accountWait = rate('account', actor.accountId);
    if (accountWait) return limited(accountWait);
    const release = requestSlots(actor.accountId);
    if (!release) return limited(2);
    res.once('close', release);
    const seatKey = JSON.stringify([actor.accountId, actor.engineName]);
    const callProduct = product ? (operation, args) => product(token, operation, args) : null;
    const human = humanMatchAccess({ actor, product: callProduct, createEngine, seats, maxSeats });
    function getSeat() {
      const current = seatContext.getStore();
      if (current) return current.seat;
      if (!seats.has(seatKey)) {
        if (seats.size >= maxSeats) throw new ToolError('capacity', 'The beta seat limit has been reached.');
        seats.set(seatKey, new GameSeat(createEngine(actor)));
      }
      const seat = seats.get(seatKey);
      if (publishSeatEvent && actor.scopes.includes('play') && !seatWatchers.has(seatKey)) {
        seatWatchers.set(seatKey, monitorSeatDecisions(seat.engine, actor, publishSeatEvent));
      }
      return seat;
    }
    const mcp = new McpServer({ name: 'thoughtseize', title: 'Thoughtseize', version: '0.4.0' }, { instructions: guideInstructions });
    const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true, sessionIdGenerator: undefined });
    registerGuides(mcp);
    if (eventRequest) registerEvents(mcp.server, actor, (method, args) => eventRequest(token, method, args));
    if (actor.scopes.includes('history')) {
      registerMatchReviewPrompt(mcp);
      registerPostMatchReviewPrompt(mcp);
    }
    registerTools(mcp, {
      actor, getSeat, allowedOrigins, human, callProduct,
      reauthorize: async () => {
        const fresh = await authorize(token);
        if (fresh?.accountId !== actor.accountId || fresh.engineName !== actor.engineName || !fresh.scopes.includes('play')) return false;
        const current = seatContext.getStore();
        return !current || Boolean(await human.policy(current.tableId).catch(() => false));
      },
    });
    res.once('close', () => { void mcp.close(); });
    try {
      await mcp.connect(transport);
      await transport.handleRequest(req, res);
    } catch {
      if (!res.headersSent) reply(res, 500, -32603, 'MCP request failed');
      else res.end();
    }
  });
  server.once('close', () => {
    for (const stop of seatWatchers.values()) stop();
    seatWatchers.clear();
    for (const seat of seats.values()) {
      seat.invalidate('process_closed');
      seat.engine.close?.();
    }
  });
  return server;
}
