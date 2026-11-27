import { setTimeout as sleep } from 'node:timers/promises';
import { McpError } from '@modelcontextprotocol/sdk/types.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { publicExplanationLimit } from '../../product/line-explanations.mjs';
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
import { registerPostMatchReviewPrompt, reviewManifestInput, reviewEvidenceInput, reviewAnnotationsInput, saveReviewAnnotationsInput, saveGameQualityInput } from './postmatch-review.mjs';
import { closedPlayerReceipts, playLine, waitForLine } from './line-runtime.mjs';
import { registerTheorycraftTools } from './theorycraft.mjs';
import { compactGameState, createViewMemory, formatGameReceipt, resetViewMemory } from './state-view.mjs';
import { cancelPlayerReservation, checkPlayerSelection, inspectPlayerReservation, playerLease, requirePlayerControl, resolvePlayerActor, samePlayerControl } from './player-seats.mjs';

const Uuid = z.uuid();
const LibraryDeckId = z.string().regex(/^[a-z0-9_:.-]{1,64}$/i);
const StringId = z.string().min(1).max(120);
const Format = z.enum(['Standard', 'Pioneer', 'Modern']);
const Cursor = z.number().int().nonnegative();
const Value = z.union([z.number().int(), z.array(z.number().int().nonnegative()).max(128)]);
const StateView = z.enum(['full', 'compact']).optional().describe('Use compact for gameplay. A choice cardRef identifies a visible card in the same state. Compact play_line and wait receipts omit card rules already sent in this game; get_game_state sends them all again. Use full (the default) for inline choice cards and printing details.');
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
  targetZone: TargetZone.optional().describe('Advanced guard for the observed prompt’s eligible zone (which can be ALL). Use select.zone for the chosen object’s location.'), role: z.number().int().nonnegative().max(32).optional()
    .describe('Zero-based target role from the engine. Supply a role or exact target instruction.'),
}).strict()).max(8).describe('Known targets in engine prompt order, using visible object IDs.');
const TurnActivation = z.object({
  kind: z.literal('activate'),
  sourceId: StringId.describe('Visible battlefield object ID of your permanent.'),
  abilityId: StringId.describe('Exact engine ability ID from this source’s nonManaAbilities in the priority choice.'),
  abilityText: z.string().min(1).max(2000).describe('Full public rule from the same nonManaAbilities entry (abilityText) or the exact visible ability picker. The short label can be truncated.'),
  when: z.enum(['stack_empty', 'priority']).default('stack_empty'),
  targets: PlannedTargets.optional().describe('Exact legal target selectors with their role or prompt guard.'),
  payWith: z.array(Payment).max(16).optional(),
  reevaluateAfter: z.boolean().optional(),
  expectTriggers: z.array(OwnTrigger).max(4).optional(),
}).strict();
const TurnPlayShape = z.object({ kind: z.literal('play'), select: ChoiceSelector, when: z.enum(['stack_empty', 'priority']).default('stack_empty'),
  playAs: z.literal('land').optional().describe('At execution the matching choice must have canPlayLand:true. A land in hand alone does not establish legality. If the object opens a picker, use the unique land option for that exact source. Omit for other plays.'),
  reevaluateAfter: z.boolean().optional().describe('Make this the last strategic intention and return control after settlement. Only guarded costs for its tracked cast/activation may follow before resolution; an untracked no-stack choice must be last. Use for uncertain effects not recognized automatically.'),
  expectCast: z.boolean().optional().describe('False for an intentional no-stack special action such as plot; lands are detected automatically. Unexpected stack additions still stop.'),
  spellAbilityId: StringId.optional().describe('Choose this exact spell or alternative-cost ability from the selected source picker.'),
  modeId: StringId.optional().describe('Choose this exact engine option ID for a mode or typed cast face of the selected spell.'),
  mode: z.string().trim().min(1).max(2000).optional().describe('Exact visible mode option text, cast option label, or printed spell face name.'),
  targets: PlannedTargets.optional(),
  payWith: z.array(Payment).max(16).optional(),
  optionalCosts: z.enum(['pay', 'decline']).optional().describe('Answer this cast\'s optional additional cost questions ("Pay Kicker {4} ?", buyback, multikicker). Include the extra mana in payWith when paying.'),
  expectTriggers: z.array(OwnTrigger).max(4).optional(), expectTargetTriggers: z.array(TargetTrigger).max(2).optional(),
}).strict();
const TurnPlay = TurnPlayShape.refine(({ playAs, expectCast, targets, payWith, spellAbilityId, modeId, mode, optionalCosts }) => playAs !== 'land'
  || (expectCast !== true && !targets?.length && !payWith?.length && !spellAbilityId && !modeId && !mode && !optionalCosts),
'A land action cannot include spell targets, casting mana or a spell forecast.')
  .refine(({ modeId, mode }) => !(modeId && mode), 'Use either a mode ID or exact mode text.');
const TurnChooseShape = z.object({ kind: z.literal('choose'),
  choiceId: StringId.optional().describe('Copy the id of a legal option from decision.choices. Pair it with the observed decisionId.'),
  select: ChoiceSelector.optional().describe('For a planned prompt, uniquely identify the legal option by object ID or exact option label.'),
  decisionId: StringId.optional().describe('Copy decision.id from the same observed state as the choice.'),
  guard: DecisionGuard.optional(),
  adoptTriggerOrder: z.literal(true).optional().describe('Follow the selected own trigger and the final forced trigger when two remain. A forecast before a reveal must name both own triggers, then select the first by source and exact label. The engine confirms the pair and stack order.'),
  value: Value.optional(), reevaluateAfter: z.boolean().optional(), expectCast: z.boolean().optional(), expectAbility: OwnActivation.optional(), skipIfTargetedBy: StringId.optional(), expectTriggers: z.array(OwnTrigger).max(4).optional(), expectTargetTriggers: z.array(TargetTrigger).max(2).optional(),
}).strict();
const TurnChoose = TurnChooseShape.refine(({ choiceId, select }) => !!choiceId !== !!select, 'Use one exact choiceId or one semantic select, as with submit_decision.')
  .refine(({ decisionId, guard, select }) => decisionId || guard && (
    ['priority', 'payMana'].includes(guard.kind) || guard.instruction !== undefined
    || guard.kind === 'panel' && (guard.sourceObjectId || guard.modePicker) && (select?.abilityId || select?.manaColor)
    || guard.kind === 'question' && guard.sourceObjectId && select?.answer !== undefined
    || guard.kind === 'target' && guard.targetSourceId && guard.targetRole !== undefined && select?.objectId
  ), { error: ({ input }) => input?.guard?.kind === 'target'
    ? 'For a target choose, use guard.targetSourceId with guard.targetRole and select.objectId, or copy the exact prompt text into guard.instruction and select a legal option. For a prompt already open, use its decisionId and choiceId.'
    : 'Use the observed decisionId, or guard a future mandatory choice with exact instruction or typed source and option.' });
const TurnAttackShape = z.object({ kind: z.literal('attack'), attackers: z.union([z.literal('all'), z.array(StringId).max(16)]).optional(),
  assignments: z.array(z.object({ attackerId: StringId, defenderId: StringId }).strict()).max(16)
    .optional().describe('Exact visible attacker–defender pairs. A defender can be a player, planeswalker or battle. Supply assignments or attackers. A plain attackers list attacks the opposing player.'),
  tokenDefenderId: StringId.optional().describe('Defender for tokens that an expected attack trigger creates tapped and attacking. Defaults to the defender of the trigger source.'),
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
const PublicExplanation = z.string().trim().min(1).max(publicExplanationLimit).optional().describe('Publish a spectator explanation when the first action is submitted. For a material play, describe your intent, one or two relevant alternatives and the deciding tradeoff from public information. Describe a resolution only after the receipt and public board support it. Keep hidden cards, credentials and private deliberation out of this audience text. Use send_chat for table conversation.');
const Turn = { explanation: PublicExplanation, gameId: Uuid, cursor: Cursor, actions: z.array(z.union([TurnPlay, TurnActivation, TurnChoose, TurnAttack, TurnBlock, Pace])).max(32),
  expectedStackIds: z.array(StringId).max(16).optional(), finish: z.enum(['next_turn', 'end_step', 'none']).default('next_turn') };
const LinePassUntilShape = z.object({
  kind: z.literal('pass_until'),
  destination: z.enum(['my_upkeep', 'my_draw', 'end_step', 'current_turn']).describe('Next own upkeep, forthcoming own draw (including this turn from upkeep), this turn’s end step, or an explicit current-turn condition. For example, current_turn with step BEGIN_COMBAT or POSTCOMBAT_MAIN and priority self returns your decision there.'),
  policy: z.enum(['if_no_play', 'decline_optional']).default('if_no_play').describe('Decline optional plays only when explicitly intended, for example to bluff a response. Both policies stop on an opponent action, new information or an unplanned required choice.'),
  declineFromDecisionId: StringId.optional().describe('With decline_optional on the first action, decline only options visible at this exact ordinary priority; later actions may follow. Stop for a different option, even on the same source.'),
  ...GameCondition,
}).strict();
const LinePassUntil = LinePassUntilShape.refine((value) => (value.destination === 'current_turn') === hasDestination(value),
  'Use phase, step or priority only with current_turn. At least one condition is required for current_turn.');
const LinePassPriority = z.object({ kind: z.literal('pass_priority') }).strict()
  .describe('Deliberately pass once and return at the next actionable boundary.');
const LineActions = z.array(z.discriminatedUnion('kind', [TurnPlay, TurnActivation, TurnChoose, TurnAttack, TurnBlock, Pace, LinePassUntil, LinePassPriority])).min(1).max(32);
const Line = {
  gameId: Uuid, cursor: Cursor, commandId: StringId.describe('Choose a unique ID for this line. For an uncertain result, reuse this ID with the same game, cursor and actions.'),
  explanation: PublicExplanation,
  reasoning: z.string().trim().min(1).max(600).optional().describe('Legacy comment for delegated broadcasts and previously authorized replay perspectives. Supply this or explanation.'),
  actions: z.array(z.union([TurnPlayShape, TurnActivation, TurnChooseShape, TurnAttackShape, TurnBlockShape, Pace, LinePassUntilShape, LinePassPriority])).min(1).max(32)
    .describe('Plan as far as current information justifies. Use exact choices for visible engine prompts. A current_turn step or phase with priority:self may precede a planned action in that window. Before attack or block, request BEGIN_COMBAT or its exact declaration step. Use at most one terminal pass (pass_priority or pass_until) and put it last.'),
  declineExiledCard: z.object({ sourceId: StringId, abilityText: z.string().min(1).max(2000), stackId: StringId.optional() }).strict().optional()
    .describe('Forgo the single face-up card from this own Valiant trigger for this command, including free plays. Supply stackId if already on the stack. Only exact attackers and an end-step pass may follow.'),
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
function withoutNullPrinting(card) {
  if (card.setCode!==null && card.cardNumber!==null) return card;
  const {setCode,cardNumber,...entry}=card;
  return {...entry,...(setCode!=null && {setCode}),...(cardNumber!=null && {cardNumber})};
}

const DeckCard = z.object({
  cardName: z.string().min(1).max(250), setCode: z.string().max(12).nullish(),
  cardNumber: z.string().max(20).nullish(), amount: z.number().int().min(1).max(250),
}).strict().transform(withoutNullPrinting);
const Deck = z.object({
  name: z.string().min(1).max(120), cards: z.array(DeckCard).min(1).max(250),
  sideboard: z.array(DeckCard).max(40).default([]),
}).strict();

function textResult(value, isError = false) {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], isError };
}

// What compact receipts already delivered to each seat in its current game.
const viewMemories = new WeakMap();
function viewMemory(seat) {
  if (!seat || typeof seat !== 'object') return undefined;
  if (!viewMemories.has(seat)) viewMemories.set(seat, createViewMemory());
  return viewMemories.get(seat);
}

function decisionReceipt(seat, receipt, view) {
  const state = receipt.state;
  if (state && !receipt.planOwnsExecution) return formatGameReceipt({ ...receipt, state: seat.withChoiceActions(state) }, view, viewMemory(seat));
  return formatGameReceipt(receipt, view, viewMemory(seat));
}

function rejectedLine({ gameId, cursor, commandId, view }, rejection, memory) {
  return formatGameReceipt({
    status: 'rejected', gameId, cursor, requestedCursor: cursor, commandId,
    actionIndex: null, appliedDecisions: 0, planOwnsExecution: false, ...rejection,
    ...(rejection.state && rejection.state.cursor !== cursor ? { cursor: rejection.state.cursor } : {}),
  }, view, memory);
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

// Each validated call captures its own actor, including work continued by its line executor.
const toolContext = new AsyncLocalStorage();

function registerTools(mcp, { contextFor, invitationOrigin }) {
  const current = () => toolContext.getStore();
  const getSeat = (...args) => current().getSeat(...args);
  function tool(name, description, inputSchema, scope, run, readOnlyHint = false) {
    if (['create_game', 'join_game', 'start_match', 'get_game_state', 'submit_decision', 'pass_until', 'advance_to_own_turn', 'play_sequence', 'submit_sequence', 'play_turn', 'play_line'].includes(name)) {
      description += ` ${guideBootstrap}`;
    }
    if (['play_sequence', 'submit_sequence'].includes(name)) description += ` ${sequenceInstructions}`;
    const scopes = scope === 'catalog' ? ['play', 'library'] : [scope === 'decks' ? 'library' : scope];
    const gameTool = ['play', 'chat'].includes(scope) && (Object.hasOwn(inputSchema, 'gameId')
      || ['list_recoverable_matches', 'get_recovery_status', 'recover_match'].includes(name));
    if (gameTool || ['create_game','join_game'].includes(name)) inputSchema = { ...inputSchema,
      humanTableId: Uuid.optional().describe('Supply the opted-in table ID on every call for the Human Player. Omit to use the MCP Player.') };
    const tournamentManagement = scope === 'tournaments:manage';
    const idempotent = ['create_tournament', 'start_tournament', 'release_stale_tournament_reservation'].includes(name);
    inputSchema = tournamentManagement ? z.strictObject(inputSchema) : { ...inputSchema, playerId: Uuid.optional().describe('Persistent Thoughtseize player ID from list_players. Supply it on each seat call when your connection controls named players. A profile-bound grant keeps its own player when omitted. Use game object IDs for targets inside actions.') };
    mcp.registerTool(name, { description, inputSchema, annotations: { readOnlyHint, ...(idempotent && { idempotentHint: true }) },
      _meta: { securitySchemes: scopes.map(value => ({ type: 'oauth2', scopes: [value] })) },
    }, async (args, extra) => {
      try {
        // History stays on the account. Its playerId names the owned player whose seat views the archive.
        const selectedContext = await contextFor(scope === 'history' ? undefined : args.playerId);
        const { actor, human, terminalReceipt, reauthorize, ownsLegacyGame } = selectedContext;
        if (scope === 'history' && actor.playerId) {
          throw new ToolError('history_account_only', 'Review and history tools read the account archive. Use the account connection; a player-bound connection cannot read history. There, playerId optionally chooses an owned player\'s perspective.');
        }
        if (!actor.scopes.includes(scope) || (tournamentManagement && (!actor.accountAgent || !actor.connectionId || actor.playerId))) {
          throw new ToolError('forbidden', tournamentManagement
            ? 'An administrator must authorize the account connection with the optional tournaments:manage permission.'
            : 'This credential lacks the required scope.');
        }
        checkPlayerSelection(actor, scope === 'history' ? { ...args, playerId: undefined } : args, name);
        const humanRoute = args.humanTableId && (gameTool || name === 'start_match');
        if (args.humanTableId && !humanRoute) throw new ToolError('player_forbidden', 'Use the opted-in Human Player tools for this table.');
        if (actor.playerSelectionEnabled && ['play', 'chat'].includes(scope)
            && !['list_players','list_tournaments','get_tournament','list_joinable_games', 'list_human_matches', 'create_human_match'].includes(name)
            && !humanRoute && !(gameTool && ownsLegacyGame(args.gameId))) {
          throw new ToolError('player_required', 'Choose a playerId from list_players and supply it on every seat call.');
        }
        const { playerId, ...selected } = args;
        const { humanTableId, ...input } = selected;
        if (scope === 'history' && playerId !== undefined) selected.perspective = playerId;
        const execute = async () => {
          if (actor.playerId && name === 'wait_for_decision' && input.gameId && input.commandId
              && input.afterCursor === undefined && input.afterDecisionId === undefined) {
            const receipt = terminalReceipt(input);
            if (receipt) return receipt;
          }
          if (actor.playerId && (gameTool || name === 'start_match')) {
            requirePlayerControl(actor);
            if (!actor.activeTableId || !actor.reservationId || actor.reservationCancelPending || (name === 'start_match' && input.tableId !== actor.activeTableId)) {
              throw new ToolError('player_table_required', scope === 'chat'
                ? 'This connection has no reservation for that table. Game chat is open only during an active game of a reserved table; XMage closes it when that game ends, including after the match.'
                : 'This connection has no reservation for that table.');
            }
            await selectedContext.getSeat().engine.open();
          }
          const result = await toolContext.run(selectedContext, () => run(gameTool ? input : selected, extra.signal));
          if (actor.playerId && ['play_line', 'wait_for_decision', 'wait_until', 'wait_for_chat'].includes(name)
              && !await reauthorize(scope)) {
            if (input.gameId && input.commandId && await reauthorize(scope, true)) {
              const receipt = terminalReceipt(input);
              if (receipt) return receipt;
            }
            throw new ToolError('forbidden', 'The player reservation changed during this call.');
          }
          if (actor.scopes.includes('chat') && ['get_game_state','wait_for_decision','play_line'].includes(name)) {
            const cursor = selectedContext.getSeat().engine.chatCursor?.(result.gameId ?? result.state?.gameId);
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
    const { callProduct } = current();
    if (!callProduct) throw new ToolError('unavailable', 'The product service is unavailable.');
    return callProduct(operation, args);
  };
  tool('get_game_state', 'Read the public battlefield and your own seat, hand, current decision and timing. secondsRemaining is a last reported cumulative match clock, not an inactivity countdown. A null clock or unknown inactivity deadline never means unlimited decision time; answer pending legal choices promptly.', { gameId: Uuid.optional(), view: StateView },
    'play', ({ gameId, view }) => {
      const seat = getSeat();
      const state = seat.withChoiceActions(seat.snapshot(gameId));
      // A state read restarts compact memory: it always carries every visible rule.
      const memory = viewMemory(seat);
      resetViewMemory(memory);
      return view === 'compact' ? compactGameState(state, memory) : state;
    }, true);
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
    if (args.commandId === undefined) {
      const seat = getSeat();
      return decisionReceipt(seat, await seat.wait(args, signal), args.view);
    }
    const invalidField = !args.gameId ? 'gameId' : args.afterCursor !== undefined ? 'afterCursor'
      : args.afterDecisionId !== undefined ? 'afterDecisionId' : null;
    if (invalidField) {
      const message = 'Use the gameId and commandId from play_line together. Omit afterCursor and afterDecisionId when waiting for that line.';
      return {
        status: 'rejected', stage: 'schema', code: 'invalid_line_wait', message,
        commandId: args.commandId, recovery: 'correct_arguments', issues: [{ path: [invalidField], code: 'custom', message }],
      };
    }
    const seat = getSeat();
    return decisionReceipt(seat, await waitForLine(seat, args, signal), args.view);
  }, true);
  tool('get_player_reservation', 'Inspect your named player reservation after a lost acknowledgement. Reports only this connection’s reservation and any identifiable owned waiting table.', {},
    'play', () => inspectPlayerReservation(current().actor, () => getSeat().engine), true);
  tool('cancel_player_reservation', 'Cancel your unsubmitted reservation or an unclaimed waiting table that you host. Copy the reservationId and, for a table, the exact tableId from get_player_reservation. An active match cannot be cancelled here.', {
    reservationId: Uuid, tableId: Uuid.optional(),
  }, 'play', args => cancelPlayerReservation(current().actor, args, fromProduct, () => getSeat().engine));
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
    }, current().reauthorize, 'ignore');
  });
  tool('advance_to_own_turn', 'Pass only when the current engine offers no non-mana optional play, stopping before your next turn or any useful legal play, mandatory decision, public opponent action or missing causal evidence. Zero mana is never evidence that no action exists.', { gameId: Uuid, cursor: Cursor },
    'play', ({ gameId, cursor }) => getSeat().startSequence({ gameId, cursor, steps: [{ kind: 'advance_to_own_turn' }] }, current().reauthorize));
  const playSequence = (args) => getSeat().startSequence(args, current().reauthorize);
  tool('play_line', 'Submit the longest justified line of plays, activations, choices, attacks and passes from the current cursor, on either turn. Ordinary handoffs are automatic. The line stops on new information, rival actions or a required choice it cannot answer. Returns applied progress and seat-visible game state. Check status, code and recovery when a line is rejected. Copy ordered payWith entries from the chosen sources’ payWithOptions. At a payment prompt or other discrete choice, an option’s playLineAction contains its exact current decisionId and choiceId. Read the turn-planning guide for complete JSON examples, including two targets, Ward, activation, combat and command recovery.', Line, 'play', async (args, signal) => {
    if (args.explanation && args.reasoning) throw new ToolError('invalid_input', 'Supply either explanation or legacy reasoning.');
    const actions = LineActions.safeParse(args.actions);
    if (!actions.success) return lineArgumentRejection(args, actions.error);
    const seat = getSeat();
    try {
      return decisionReceipt(seat, await playLine(seat, { ...args, actions: actions.data }, current().reauthorize, signal), args.view);
    } catch (error) {
      if (!(error instanceof ToolError) || !error.lineRejection) throw error;
      return rejectedLine(args, {
        stage: 'preflight', code: error.code, message: error.message, recovery: error.lineRejection,
        actionIndex: error.actionIndex ?? null,
        ...(error.field ? { issues: [{ path: ['actions', error.actionIndex, error.field, ...(error.paymentIndex !== undefined ? [error.paymentIndex] : [])], code: error.code, message: error.message }] } : {}),
        ...(error.state ? { state: seat.withChoiceActions(error.state) } : {}),
      }, viewMemory(seat));
    }
  });
  tool('play_turn', 'Plan a complete turn with significant plays, public targets, chosen mana sources, guarded costs/choices and attacks. The executor makes legal ordinary passes between intentions; do not enumerate passes or predict priority windows. Own declared spells/triggers and the initial own stack may resolve; real rival actions, new information, unknown mandatory choices and chosen stops interrupt. finish next_turn advances only while no useful legal action remains, never because mana is zero.', Turn, 'play', (args) => getSeat().startTurn(args, current().reauthorize));
  tool('play_sequence', 'Queue guarded choices by exact ID, card or label. Mark a planned cast with expectCast to let later steps pay for that same spell.', Sequence, 'play', playSequence);
  tool('submit_sequence', 'Start a conditional, bounded sequence of choices, brief waits and ordinary passes.', Sequence, 'play', playSequence);
  tool('get_sequence_status', 'Check progress and interruption for your plan. If transport lost its returned ID, recover with the exact startCursor submitted with that plan; inspect accepted counts and state before retrying any action.', { gameId: Uuid, sequenceId: Uuid.optional(), startCursor: Cursor.optional() }, 'play',
    (args) => getSeat().sequenceStatus(args), true);
  tool('cancel_sequence', 'Cancel unapplied steps without undoing moves already accepted by XMage.', { gameId: Uuid, sequenceId: Uuid }, 'play',
    (args) => getSeat().cancelSequence(args));

  const agentRuntime = {
    provider: z.enum(['openai', 'claude', 'gemini']).optional().describe('Provider of your playing model, if known.'),
    model: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9.:/_+-]{0,95}$/).optional().describe('Your actual playing model ID if known.'),
    reasoningEffort: z.string().regex(/^[a-z][a-z0-9_-]{0,23}$/).optional().describe('Your configured reasoning effort if known, such as high.'),
  };
  tool('create_player_slot', 'Create one enabled persistent player in your own account. Requires explicit account consent to manage slots. Reuse the requestId when retrying.', {
    requestId:Uuid, displayName:z.string().trim().min(1).max(40), flag:z.string().regex(/^[A-Za-z]{2}$/).optional(), ...agentRuntime,
  }, 'players:manage', args => fromProduct('create_player_slot',args));
  tool('list_players', 'List your authorized persistent players. Availability distinguishes available, reserved before binding, and occupied at a table.', {availableOnly:z.boolean().optional()}, 'play', async args => {
    const { players } = await fromProduct('list_players', args);
    return { players: players.map(({ playerId, displayName, flag, engineName, mcpEnabled, activeTableId, availability, provider, model, reasoningEffort }) =>
      ({ playerId, displayName, flag, engineName, mcpEnabled, activeTableId, availability, provider, model, reasoningEffort })) };
  }, true);
  tool('list_tournaments', 'Discover constructed tournaments, structures and registration status.', {}, 'play',
    () => fromProduct('list_tournaments', {}), true);
  const bestOf = z.union([z.literal(3), z.literal(5)]);
  tool('create_tournament', 'Open registration for a Constructed tournament as the human organizer. Requires an administrator account connection with tournament consent. Reuse the requestId and settings when retrying. Start play with start_tournament or from the returned adminUrl.', {
    requestId: Uuid.describe('A fresh UUID per event, kept across retries.'),
    name: z.string().trim().min(1).max(100),
    format: Format.default('Standard'),
    template: z.enum(['attendance', 'worlds']).default('attendance').describe('Attendance scales with checked-in players. Worlds uses 14 Standard Swiss rounds and a Top 8.'),
    capacity: z.number().int().min(2).max(512).optional().describe('Defaults to 8 seats, or 128 for Worlds.'),
    cut: z.enum(['none', 'auto']).optional().describe('Defaults to rounds only for attendance. Auto uses the attendance cut up to Top 8. Worlds requires auto.'),
    swissRounds: z.number().int().min(1).max(14).optional().describe('Override the round count for rounds-only events. Eight checked-in players play three rounds by default.'),
    swissBestOf: bestOf.optional().describe('Defaults to 3.'),
    playoffBestOf: bestOf.optional().describe('Defaults to 3 for attendance or 5 for Worlds.'),
    maxAgentsPerOwner: z.number().int().min(1).max(512).optional().describe('Defaults to capacity.'),
    breakMinutes: z.number().int().min(0).max(1440).optional().describe('Minutes between rounds. Defaults to 5.'),
    coaching: z.boolean().optional().describe('Allow coaching for a casual tournament. Defaults to false.'),
  }, 'tournaments:manage', args => {
    const worlds = args.template === 'worlds';
    return fromProduct('create_tournament', { ...args, cut: args.cut ?? (worlds ? 'auto' : 'none'), capacity: args.capacity ?? (worlds ? 128 : 8) });
  });
  tool('start_tournament', 'Start the first round of the exact tournament you organized once the expected number of players is connected. Requires your administrator account connection with tournaments:manage. Confirm the event ID and attendance before calling. Reuse the same requestId and expectedPlayers to recover the original start receipt.', {
    tournamentId: Uuid,
    requestId: Uuid.describe('A fresh UUID v4 for this start, kept across retries.'),
    expectedPlayers: z.number().int().min(2).max(512).describe('The exact number of entrants who must be connected when the first round opens.'),
  }, 'tournaments:manage', args => fromProduct('start_tournament', args));
  tool('inspect_tournament_reservations', 'Inspect reservation availability for your own agent entrants in a tournament you organize. A stale row includes exact arguments for a separate release call. Uses your administrator account connection with tournaments:manage.', {
    tournamentId: Uuid,
  }, 'tournaments:manage', args => fromProduct('inspect_tournament_reservations', args), true);
  tool('release_stale_tournament_reservation', 'Release one verified stale reservation left by a finished tournament you organized. Pass the exact release object from inspect_tournament_reservations. Repeating after a successful release is safe; if a newer reservation exists, inspect again.', {
    tournamentId: Uuid.describe('Finished tournament ID from the release object.'),
    pairingId: Uuid,
    participantId: Uuid.describe('Your player ID from the release object.'),
    tableId: Uuid,
    expectedReservationId: Uuid,
  }, 'tournaments:manage', args => fromProduct('release_stale_tournament_reservation', args));
  tool('get_tournament', 'Read public standings, pairings for a round or a published deck. Entry IDs come from standings.', {
    tournamentId: Uuid,
    section: z.enum(['standings', 'pairings', 'deck']).default('standings'),
    roundNumber: z.number().int().positive().optional(),
    entryId: Uuid.optional(),
    offset: z.number().int().nonnegative().default(0),
    limit: z.number().int().min(1).max(64).default(16),
  }, 'play', async ({ tournamentId, section, roundNumber, entryId, offset, limit }) => {
    const event = await fromProduct('get_tournament', { tournamentId });
    const summary = { tournamentId, name:event.name, status:event.status, stage:event.stage, roundNumber:event.roundNumber, roundsTotal:event.roundsTotal, cutSize:event.cutSize, championId:event.championId };
    if (section === 'deck') {
      if (!entryId) throw new ToolError('invalid_input', 'Supply an entryId from standings.');
      const deck = event.deckLists.find(item => item.entryId === entryId);
      if (!deck) throw new ToolError('not_found', 'No published decklist for this entry.');
      return { ...summary, deck };
    }
    const rows = section === 'standings' ? event.standings : event.pairings.filter(pair => pair.roundNumber === (roundNumber ?? event.roundNumber));
    return { ...summary, [section]:rows.slice(offset, offset + limit), total:rows.length };
  }, true);
  tool('join_tournament', 'Register your persistent agent with a saved deck. Repeating this before registration closes can replace the registered list.', {
    tournamentId: Uuid, deckId: LibraryDeckId,
  }, 'play', args => {
    if (!current().actor.playerId) throw new ToolError('player_required', 'Choose your persistent agent playerId.');
    return fromProduct('join_tournament', args);
  });
  tool('wait_for_next_round', 'Check in as online, recover your existing table, or wait for the next tournament assignment. Call again while waiting; close your session between tournament days.', {
    tournamentId: Uuid, waitMs: z.number().int().min(0).max(25_000).default(20_000),
  }, 'play', async ({ tournamentId, waitMs }, signal) => {
    if (!current().actor.playerId) throw new ToolError('player_required', 'Choose your persistent agent playerId.');
    const deadline = Date.now() + waitMs;
    do {
      const result = await fromProduct('wait_for_next_round', { tournamentId });
      if (result.tableId) {
        // A Product assignment verifies membership and reserves this exact table first.
        const engine = getSeat(true).engine;
        await engine.open();
        engine.acceptTournamentTable(result.tableId);
        const confirmed = await fromProduct('wait_for_next_round', { tournamentId, readyTableId: result.tableId });
        const { ownGamePlayerId, ...assignment } = confirmed;
        if (ownGamePlayerId && assignment.gameId) engine.resumeTournamentGame(assignment.tableId, assignment.gameId, ownGamePlayerId);
        return assignment;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0 || !['waiting','registration','preparing','break'].includes(result.state)) return result;
      await sleep(Math.min(remaining, 2000), undefined, { signal });
    } while (true);
  });
  const inviteLocator={tableId:Uuid.optional(), inviteLink:z.string().min(1).max(2048).optional()};
  function locateInvitation(tableId,inviteLink) {
    if (!inviteLink) return tableId ? {tableId} : {};
    if (tableId) throw new ToolError('invalid_invite','Provide either the invite link or the table ID.');
    const invalid=()=>new ToolError('invalid_invite','Provide the private link copied from this Thoughtseize deployment.');
    // Installations without a public URL emit root-relative links. Their parser
    // never adopts an origin from the caller, the request Host or the CORS list.
    const relative=!invitationOrigin && inviteLink.startsWith('/join/');
    const url=URL.parse(inviteLink,relative?'https://relative.invalid':undefined);
    if (!url || (relative ? url.pathname+url.hash!==inviteLink : url.origin!==invitationOrigin)) throw invalid();
    const path=/^\/join\/(mcp\/)?([0-9a-f-]+)$/i.exec(url.pathname);
    const capability=/^#invite=([A-Za-z0-9_-]{43})$/.exec(url.hash);
    if (url.username || url.password || url.search || !path
        || !Uuid.safeParse(path[2]).success || (path[1] ? !capability : Boolean(url.hash))) throw invalid();
    return {tableId:path[2],...(capability && {inviteToken:capability[1]})};
  }
  tool('list_joinable_games', 'List incoming invitations to your account and enabled players. Inspect one external invitation using its complete private inviteLink.', {
    ...inviteLocator, limit:z.number().int().min(1).max(50).default(25),
  }, 'play', ({tableId,inviteLink,limit}) => fromProduct('list_joinable_games', {limit,...locateInvitation(tableId,inviteLink)}), true);
  const playDeck = {
    deck: Deck.optional(),
    deckId: LibraryDeckId.optional().describe('ID from list_decks. Supply this or an inline deck.'),
  };
  async function getLibraryDeck(args) {
    const saved=await fromProduct('get_deck',args);
    if (!saved?.data) return saved;
    const data={...saved.data};
    for (const zone of ['cards','sideboard']) {
      if (Array.isArray(data[zone])) data[zone]=data[zone].map(withoutNullPrinting);
    }
    return {...saved,data};
  }
  async function resolvePlayDeck(deck, deckId, library = 'agent') {
    if (Boolean(deck) === Boolean(deckId)) throw new ToolError('invalid_deck', 'Choose one library deck ID or supply an inline deck.');
    if (!deckId) return deck;
    const saved = await getLibraryDeck({ deckId });
    if (saved?.id !== deckId || (saved.library !== library && !(library === 'agent' && saved.library === 'private')) || !saved.data) {
      throw new ToolError('deck_unavailable', 'Choose a saved deck from the playing seat’s library.');
    }
    const { name, cards, sideboard } = saved.data;
    return { name, cards, sideboard, libraryDeckId: deckId };
  }
  async function withTableReservation(joinTableId, run) {
    const lease = playerLease(current().actor, fromProduct, joinTableId);
    await lease?.reserve();
    let engine;
    try {
      engine = getSeat(Boolean(lease)).engine;
    } catch (error) {
      await lease?.release();
      throw error;
    }
    return run(engine, lease);
  }
  tool('list_human_matches', 'Find your waiting or in-progress opted-in Human Player tables, including browser-created tables. Returns tableId and live XMage status.', {}, 'play', () => {
    current().human.requireAccount();
    return fromProduct('list_human_matches', {});
  }, true);
  tool('list_human_decks', 'List personal decks that can be selected for a Human Player match.', {}, 'decks', () => {
    current().human.requireAccount();
    return fromProduct('list_human_decks', {});
  }, true);
  const recipientFields = {
    guestPlayerId:Uuid.optional().describe('Exact player UUID voluntarily supplied by the guest.'),
    guestAccountName:z.string().trim().min(3).max(24).optional().describe('Recipient account. Its owner selects one enabled player when claiming.'),
    guestEngineName:z.string().trim().min(1).max(36).optional().describe('Exact registered engine seat.'),
  };
  const recipientCount = (...values) => values.filter(value => value !== undefined).length;
  tool('create_human_match', 'Create an unrated match as the signed-in Human Player. MCP and friend matches wait for a guest and start_match. Practice and bot start immediately. humanMcpAllowed opts just this table into MCP gameplay.', {
    mode: z.enum(['mcp', 'friend', 'practice', 'bot']), format: Format, name: z.string().trim().min(1).max(80),
    deck: Deck.optional(), deckId: LibraryDeckId.optional(),
    humanMcpAllowed: z.boolean().default(false), winsNeeded: z.union([z.literal(1), z.literal(2)]).default(1),
    ...recipientFields,
    chatMode: z.enum(['quiet', 'chatty', 'coach']).optional().describe('MCP opponent only.'),
    botDeck: Deck.optional().describe('Bot opponent deck. Defaults to a mirror of the human deck.'),
  }, 'play', async ({ mode, format, name, deck, deckId, humanMcpAllowed, winsNeeded, guestEngineName, guestPlayerId, guestAccountName, chatMode, botDeck }) => {
    current().human.requireAccount();
    const count=recipientCount(guestPlayerId,guestEngineName,guestAccountName);
    if (count>1 || (count && !['friend','mcp'].includes(mode)) || guestEngineName && mode !== 'friend' || chatMode && mode !== 'mcp' || botDeck && mode !== 'bot') {
      throw new ToolError('invalid_input', 'Opponent options must match the selected game mode.');
    }
    const register = ['mcp', 'friend'].includes(mode) ? record => fromProduct('create_human_invitation', {
      ...record, mode, ...(guestPlayerId && {guestPlayerId}), ...(guestAccountName && {guestAccountName}), ...(guestEngineName ? { guestEngineName } : {}), ...(chatMode ? { chatMode } : {}),
    }) : undefined;
    return current().human.create({ mode, format, name, humanMcpAllowed, winsNeeded, botDeck,
      deck: await resolvePlayDeck(deck, deckId, 'personal') }, register);
  });
  tool('create_game', 'Create a private, unrated best-of-three table as this agent seat.', {
    format: Format, name: z.string().trim().min(1).max(80), ...playDeck,
    ...recipientFields, ...agentRuntime,
    spectatorVisibility: z.enum(['public-board','both-hands']).optional().describe('Public board by default. Both-hands adds a separate owner-shared live spectator link for this MCP table. A guest of another account must explicitly accept.'),
  }, 'play', async ({ guestPlayerId, guestAccountName, guestEngineName, spectatorVisibility, provider, model, reasoningEffort, deck, deckId, ...args }) => {
    if (recipientCount(guestPlayerId,guestAccountName,guestEngineName)!==1) throw new ToolError('invalid_input','Choose exactly one guest player, account, or engine name.');
    const selectedDeck = await resolvePlayDeck(deck, deckId);
    return withTableReservation(undefined, (engine, lease) => engine.createGame({ ...args, deck: selectedDeck },
      record => fromProduct('create_game_invite', { ...record, tableName: args.name, spectatorVisibility, guestEngineName, guestPlayerId, guestAccountName, provider, model, reasoningEffort }), lease));
  });
  tool('join_game', 'Join a private table from its Thoughtseize invite link or table ID. Use a legal deck and an optional seat display name.', {
    ...inviteLocator,
    displayName: z.string().trim().min(1).max(24).optional(), ...playDeck, ...agentRuntime,
    acceptSpectatorVisibility:z.literal('both-hands').optional().describe('Accept the advertised private broadcast on a cross-account invitation.'),
  }, 'play', async ({ tableId, inviteLink, displayName, acceptSpectatorVisibility, provider, model, reasoningEffort, deck, deckId }) => {
      const destination=locateInvitation(tableId,inviteLink);
      tableId=destination.tableId;
      if (!tableId) throw new ToolError('invalid_invite','Provide the invite link or table ID.');
      const invitation = await fromProduct('inspect_game_invite', destination);
      if (invitation.requiresSpectatorAcceptance && acceptSpectatorVisibility!=='both-hands') throw new ToolError('spectator_consent_required','This invitation shares both hands with its spectator. Explicitly accept this visibility to join.');
      const selectedDeck = await resolvePlayDeck(deck, deckId);
      return withTableReservation(tableId, (engine, lease) => engine.joinGame({ tableId, deck: selectedDeck }, invitation,
        () => fromProduct('get_game_invite', { ...destination, displayName, ...(invitation.mode==='friend' && {expectedSpectatorVisibility:invitation.spectatorVisibility??'public-board'}), ...(acceptSpectatorVisibility && {acceptSpectatorVisibility}), provider, model, reasoningEffort }), lease));
    });
  tool('start_match', 'Start a ready table as its host. For the MCP Player provide tableId. For the Human Player provide humanTableId, including to finish setup of an MCP-created table with human gameplay disabled.', {
    tableId: Uuid.optional(), humanTableId: Uuid.optional(),
  }, 'play', ({ tableId, humanTableId }) => {
    if (Boolean(tableId) === Boolean(humanTableId)) throw new ToolError('invalid_input', 'Select exactly one host table.');
    return humanTableId ? current().human.start(humanTableId) : getSeat().engine.startMatch(tableId);
  });
  tool('concede', 'Surrender this game (default) or the whole match explicitly. Cancels the remaining queued plan before sending the concession; accepted earlier actions remain applied.', { gameId: Uuid, entireMatch: z.boolean().default(false) }, 'play',
    ({ gameId, entireMatch }) => { const seat = getSeat(); seat.snapshot(gameId); seat.invalidate('conceded'); return seat.engine.concede(gameId, entireMatch); });
  tool('get_sideboard_state', 'Read this seat’s current deck and decisionId together at every sideboard window. Use the distribution supplied by the open prompt, including after match recovery.', { gameId: Uuid.optional() }, 'play',
    ({ gameId }) => getSeat().engine.sideboardState(gameId), true);
  tool('submit_sideboard', 'Submit the full next-game deck for the current decisionId. To keep, copy deck from that same read. Check intended moves from the current deck first. The private mainDeckChanges receipt summarizes the accepted submission by card name.', {
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
    gameId: Uuid, message: z.string().max(500).regex(/\S/u, 'A chat message cannot be blank.'),
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
  tool('validate_deck', 'Check the submitted list or the data field from get_deck against XMage constructed rules.', {
    format: Format, deck:z.looseObject(Deck.shape),
  }, 'decks', ({format,deck:{name,cards,sideboard}})=>getSeat().engine.validateDeck({format,deck:{name,cards,sideboard}}), true);
  const DeckLibrary = z.enum(['agent','private']).optional().describe('Shared account agent library, or the selected agent’s own private library.');
  tool('list_decks', 'List the reusable MCP opponent decks in your private account library. These appear in the web library under MCP opponent decks.', { library: DeckLibrary }, 'decks', args => fromProduct('list_decks', args), true);
  tool('get_deck', 'Read one deck in your library. Pass its format and data directly to validate_deck.', { deckId: LibraryDeckId }, 'decks', getLibraryDeck, true);
  tool('list_deck_archetypes', 'List all predefined library archetypes for the format (Pioneer: MTGTop8 archetype names). Use one label in create_deck and update_deck.', { format: Format },
    'decks', args => fromProduct('list_deck_archetypes', args), true);
  tool('create_deck', 'Save a reusable MCP opponent deck in your private library. It remains available in later sessions and appears under MCP opponent decks on the web.', { library: DeckLibrary, name: z.string().min(1).max(120), format: Format, archetype: z.string().min(1).max(150), deck: Deck },
    'decks', (args) => fromProduct('create_deck', args));
  tool('update_deck', 'Save a revision if your current deck revision still matches.', {
    library: DeckLibrary, deckId: LibraryDeckId, expectedRevision: z.number().int().positive(), name: z.string().min(1).max(120), format: Format, archetype: z.string().min(1).max(150), deck: Deck,
  }, 'decks', (args) => fromProduct('update_deck', args));
  tool('list_matches', 'List your finished and interrupted matches, filtered by format. endCause names a series that ended without being played out, such as inactivity. On the account connection, playerId optionally chooses an owned player\'s perspective.', {
    format: Format.optional(), cursor: z.string().max(160).optional(), limit: z.number().int().min(1).max(50).default(25),
  }, 'history', (args) => fromProduct('list_matches', args), true);
  tool('get_match', 'Read one participant-authorized match and its games, with endCause when a game or the series was not played out. On the account connection, playerId optionally chooses an owned player\'s perspective.', { matchId: Uuid },
    'history', (args) => fromProduct('get_match', args), true);
  const replayPage = { gameId: Uuid, start: Cursor.default(0), count: z.number().int().min(1).max(50).default(25) };
  tool('get_replay', 'Read one redacted replay page from your perspective. On the account connection, playerId chooses which owned player\'s completed seat to view.', replayPage, 'history',
    (args) => fromProduct('get_replay', args), true);
  tool('query_match_events', 'Read ordered, authorized and cursor-paginated events for one game to analyze its play.', replayPage, 'history',
    (args) => fromProduct('get_replay', args), true);
  tool('evaluate_match', 'Read pre-action evidence for one completed game from the authorized player perspective. Use next as the next page’s start.', {
    gameId: Uuid, start: Cursor.default(0), count: z.number().int().min(1).max(4).default(4),
  }, 'history', (args) => fromProduct('evaluate_match', args), true);
  tool('score_match_evaluation', 'Calculate game accuracy and coverage from reviewed positions. Low-confidence positions are excluded from the score.', {
    gameId: Uuid, positions: scoredPositions,
  }, 'history', (args) => fromProduct('score_match_evaluation', args), true);
  tool('get_match_review', 'Read the match or game review manifest, available perspectives, coverage, saved counts and game quality. Supply one matchId or gameId. Set archiveOnly to true for revision, quality and archive status without loading replay evidence. For qualitative review, read get_guide with guideId replay-analysis or start the review_playmat_replay prompt.',
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
  tool('save_game_quality', 'Save a game-wide quality verdict with an optional Markdown reason and evidence anchor. The account must own both seats. Use the game ID and archive revision from get_match_review. Only representative games without major interruptions, confusion or misplays qualify for true.',
    saveGameQualityInput, 'history', (args) => fromProduct('save_game_quality', args));
  registerTheorycraftTools(tool, fromProduct);
  tool('export_matches', 'Request an authorized download handle for selected games.', {
    gameIds: z.array(Uuid).min(1).max(10),
  }, 'history', (args) => fromProduct('export_matches', args));
}

export function createMcpServer({
  authorize, createEngine, product, eventRequest, publishSeatEvent, oauthResourceMetadata, invitationOrigin, allowedOrigins = [], maxSeats = 64,
}) {
  const seats = new Map();
  const seatWatchers = new Map();
  const terminal = new Map();
  const activeReaders = new WeakMap();
  const receiptKey = (accountId, playerId, connectionId, gameId, commandId) =>
    JSON.stringify([accountId, playerId, connectionId, gameId, commandId]);
  function retire(key, seat) {
    if (seat.engine.profileId) {
      const [accountId] = JSON.parse(key);
      for (const receipt of closedPlayerReceipts(seat)) {
        terminal.set(receiptKey(accountId, seat.engine.profileId, seat.engine.profileConnectionId, receipt.gameId, receipt.commandId), receipt);
        if (terminal.size > 1024) terminal.delete(terminal.keys().next().value);
      }
    }
    seat.invalidate('seat_retired');
    seatWatchers.get(key)?.();
    seatWatchers.delete(key);
    seat.engine.close?.();
    seats.delete(key);
  }
  function makeRoom() {
    if (seats.size < maxSeats) return;
    for (const [key, seat] of seats) {
      if (!seat.engine.profileId || activeReaders.get(seat)) continue;
      const state = seat.snapshot();
      if (state.status === 'match_over' || (state.status === 'lobby' && !state.tableId && !seat.engine.profileTableId)) {
        retire(key, seat);
        return;
      }
    }
    throw new ToolError('capacity', 'The beta seat limit has been reached.');
  }
  // Colocated pilots share one source address, so the pre-authentication budget is wider
  // than one account's. Both windows are per minute.
  const rate = createLimits({
    ingress: { client: 1200, total: 6000, window: 60_000 },
    account: { client: 600, total: 4000, window: 60_000 },
  });
  // An SDK client keeps its GET event stream open while making tool calls.
  // An eight-seat tournament plus its organizer can use nine of each per account.
  // A rate-exempt (administrator) account skips its per-account rate and caps and is
  // bounded only by the instance-wide totals below.
  const authSlots = createConcurrencyLimit(32, 16);
  const streamSlots = createConcurrencyLimit(24, 9);
  const operationSlots = createConcurrencyLimit(48, 9);
  const combinedSlots = createConcurrencyLimit(48, 18);
  const limitLog = new Map();
  function logLimited(reason) {
    const now = Date.now();
    const entry = limitLog.get(reason);
    if (entry && now - entry.at < 10_000) { entry.count++; return; }
    console.warn('MCP request limited', { reason, suppressed: entry?.count ?? 0 });
    limitLog.set(reason, { at: now, count: 0 });
  }
  const server = createServer({ requestTimeout: 30_000, headersTimeout: 10_000 }, async (req, res) => {
    const pathname = req.url?.split('?')[0];
    if (pathname === '/healthz' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
      res.end('ok');
      return;
    }
    if (pathname !== '/mcp') return reply(res, 404, -32601, 'Not found');
    function limited(seconds, reason) {
      res.setHeader('X-Playmat-Limit-Reason', reason);
      res.setHeader('Retry-After', String(seconds));
      logLimited(reason);
      return reply(res, 429, -32029, 'Too many MCP requests. Try again shortly.');
    }
    const source = clientKey(req);
    const ingressWait = rate('ingress', source);
    if (ingressWait) return limited(ingressWait, 'ingress-rate');
    const token = readToken(req);
    if (req.headers.origin && !allowedOrigins.includes(req.headers.origin)) return reply(res, 403, -32600, 'Origin not allowed');
    function unauthorized() {
      if (oauthResourceMetadata) res.setHeader('WWW-Authenticate', 'Bearer resource_metadata="' + oauthResourceMetadata + '"');
      return reply(res, 401, -32001, 'Unauthorized');
    }
    if (!token) return unauthorized();

    const releaseAuth = authSlots(source);
    if (!releaseAuth) return limited(2, 'auth-concurrency');
    let actor;
    try { actor = await authorize(token); }
    catch { return reply(res, 503, -32000, 'Authorization service unavailable'); }
    finally { releaseAuth(); }
    if (!actor || !actor.accountId || !actor.engineName || !Array.isArray(actor.scopes)) return unauthorized();

    if (res.destroyed) return;
    const exempt = actor.rateExempt === true;
    const accountWait = exempt ? 0 : rate('account', actor.accountId);
    if (accountWait) return limited(accountWait, 'account-rate');
    const stream = req.method === 'GET';
    const accountCap = exempt ? Infinity : undefined;
    const releaseKind = (stream ? streamSlots : operationSlots)(actor.accountId, accountCap);
    if (!releaseKind) return limited(2, stream ? 'stream-concurrency' : 'operation-concurrency');
    const releaseCombined = combinedSlots(actor.accountId, accountCap);
    if (!releaseCombined) {
      releaseKind();
      return limited(2, 'global-concurrency');
    }
    res.once('close', () => { releaseKind(); releaseCombined(); });
    async function contextFor(selector) {
      const selected = await resolvePlayerActor(actor, selector, id => authorize(token, id));
      return playerContext(selected, selector);
    }
    function playerContext(actor, selector) {
      const seatKey = actor.playerId ? JSON.stringify([actor.accountId, 'player', actor.playerId])
        : JSON.stringify([actor.accountId, actor.engineName]);
      const callProduct = product ? (operation, args) => product(token, operation, args, selector) : null;
      const human = humanMatchAccess({ actor, product: callProduct, createEngine, seats, maxSeats });
      const used = new Set();
      function terminalReceipt({ gameId, commandId }) {
        const saved = terminal.get(receiptKey(actor.accountId, actor.playerId, actor.connectionId, gameId, commandId));
        if (saved) return saved;
        const seat = seats.get(seatKey);
        if (seat?.engine.profileConnectionId === actor.connectionId && seat.engine.profileId === actor.playerId) {
          return closedPlayerReceipts(seat).find(receipt => receipt.gameId === gameId && receipt.commandId === commandId);
        }
      }
      function getSeat(newReservation = false) {
        requirePlayerControl(actor);
        const current = seatContext.getStore();
        if (current) return current.seat;
        const prior = seats.get(seatKey);
        if (prior && actor.playerId && !prior.engine.matchesPlayerGrant(actor)) {
          if (!newReservation && !actor.reservationId) {
            throw new ToolError('player_busy', 'Reserve this player before replacing its existing connection.');
          }
          retire(seatKey, prior);
        }
        if (!seats.has(seatKey)) {
          makeRoom();
          seats.set(seatKey, new GameSeat(createEngine(actor)));
        }
        const seat = seats.get(seatKey);
        if (actor.playerId && !used.has(seat)) {
          used.add(seat);
          activeReaders.set(seat, (activeReaders.get(seat) ?? 0) + 1);
          res.once('close', () => activeReaders.set(seat, activeReaders.get(seat) - 1));
        }
        if (publishSeatEvent && actor.scopes.includes('play') && !seatWatchers.has(seatKey)) {
          seatWatchers.set(seatKey, monitorSeatDecisions(seat.engine, actor, publishSeatEvent));
        }
        return seat;
      }
      async function reauthorize(scope = 'play', completedReceipt = false) {
        const fresh = await authorize(token, selector);
        if (fresh?.accountId !== actor.accountId || fresh.engineName !== actor.engineName || !fresh.scopes.includes(scope)) return false;
        if (completedReceipt) return fresh.playerId === actor.playerId && fresh.connectionId === actor.connectionId;
        if (!samePlayerControl(actor, fresh)) return false;
        const current = seatContext.getStore();
        return !current || Boolean(await human.policy(current.tableId).catch(() => false));
      }
      function ownsLegacyGame(gameId) {
        if (!gameId || !actor.connectionId) return false;
        const seat = seats.get(seatKey);
        if (seat?.engine.profileConnectionId !== actor.connectionId) return false;
        const state = seat.snapshot();
        if (state.gameId !== gameId || !state.tableId || !['active', 'sideboarding', 'game_over'].includes(state.status)) return false;
        // Another controlled participant at the same table makes the game ID ambiguous.
        return !Array.from(seats.values()).some(other => other !== seat
          && other.engine.profileConnectionId === actor.connectionId
          && (other.engine.profileTableId === state.tableId || other.engine.humanTableId === state.tableId));
      }
      return { actor, getSeat, terminalReceipt, callProduct, human, reauthorize, ownsLegacyGame };
    }
    const mcp = new McpServer({ name: 'thoughtseize', title: 'Thoughtseize', version: '0.5.0' }, { instructions: guideInstructions });
    const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true, sessionIdGenerator: undefined });
    registerGuides(mcp);
    if (eventRequest) registerEvents(mcp.server, actor, async (method, params) => {
      const { playerId, ...args } = params;
      if (playerId !== undefined && !Uuid.safeParse(playerId).success) throw new McpError(-32602, 'Invalid playerId.');
      if (!playerId && actor.playerSelectionEnabled) throw new McpError(-32602, 'Supply a playerId from list_players for seat events.');
      let selected;
      try { selected = (await contextFor(playerId)).actor; }
      catch { throw new McpError(-32001, 'This connection cannot select that player.'); }
      if (!selected.scopes.includes('play')) throw new McpError(-32001, 'A Thoughtseize play seat is required.');
      return eventRequest(token, method, args, playerId);
    });
    if (!actor.playerId && actor.scopes.includes('history')) {
      registerMatchReviewPrompt(mcp);
      registerPostMatchReviewPrompt(mcp);
    }
    registerTools(mcp, { contextFor, invitationOrigin });
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
