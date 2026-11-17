import { createServer } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { GameSeat, ToolError } from './game-seat.mjs';
import { monitorSeatDecisions, registerEvents } from './events.mjs';
import { listArchetypes, possibleResponses, searchCards } from './catalog.mjs';
import { guideBootstrap, guideInstructions, registerGuides, sequenceInstructions } from './guides.mjs';
import { registerMatchReviewPrompt, scoredPositions } from './match-review.mjs';

const Uuid = z.uuid();
const StringId = z.string().min(1).max(120);
const Format = z.enum(['Standard', 'Pioneer', 'Modern']);
const Cursor = z.number().int().nonnegative();
const Value = z.union([z.number().int(), z.array(z.number().int().nonnegative()).max(128)]);
const GameCondition = {
  phase: z.string().min(1).max(32).optional(),
  step: z.string().min(1).max(40).optional(),
  priority: z.enum(['self', 'opponent', 'none']).optional(),
};
const hasDestination = (value) => value.phase !== undefined || value.step !== undefined || value.priority !== undefined;
const Hold = z.object({ kind: z.literal('hold'), delayMs: z.number().int().min(1).max(10_000) }).strict();
const ChoiceSelector = z.object({
  cardName: z.string().trim().min(1).max(250).optional(),
  cardId: StringId.optional(), label: z.string().trim().min(1).max(500).optional(),
  zone: z.enum(['hand', 'battlefield']).optional(),
}).strict().refine(({ cardName, cardId, label }) => cardName || cardId || label, 'Name the exact card or choice label.');
const Answer = z.object({
  kind: z.literal('answer'), choiceId: StringId.optional(), select: ChoiceSelector.optional(), decisionId: StringId.optional(),
  guard: z.object({ kind: StringId, ...GameCondition, instruction: z.string().min(1).max(2000).optional() }).strict().optional(), value: Value.optional(),
  expectCast: z.boolean().default(false),
  expectTriggers: z.array(z.object({
    sourceId: StringId,
    abilityText: z.string().min(1).max(2000),
    count: z.number().int().min(1).max(4).default(1),
  }).strict()).max(4).optional().describe('Predeclare exact own triggered abilities caused by this answer: public source object ID, exact public ability text and bounded count. Never matches opponent abilities.'),
}).strict()
  .refine(({ choiceId, select }) => !!choiceId !== !!select, 'Use one exact choice ID or one semantic selector.')
  .refine((value) => value.decisionId || (value.guard && hasDestination(value.guard)),
  'A planned answer needs the exact decision ID or a guard with its expected kind and destination.');
const YieldPriority = z.object({
  kind: z.literal('yield_priority'), until: z.enum(['self', 'opponent']).default('self').describe('Pass exactly once, then wait for a new self decision or the observed opponent handoff.'),
  allowPlannedResolutions: z.boolean().default(false).describe('Allow only removal of this plan’s expected spell/trigger objects; unexpected responses and public opponent changes still interrupt.'),
}).strict();
const PassUntil = z.object({
  kind: z.literal('pass_until').describe(sequenceInstructions), ...GameCondition,
  stackEmpty: z.literal(true).optional().describe('Require an empty stack in addition to other destination conditions.'),
  allowPlannedResolutions: z.boolean().default(false).describe('Allow only removal of this plan’s expected spell/trigger objects; unexpected responses and public opponent changes still interrupt.'),
  skipOptionalResponses: z.boolean().default(false).describe('Keep false unless intentionally declining every optional play, including land drops. Never use this to wait for your next turn.'),
}).strict().refine((value) => hasDestination(value) || value.stackEmpty === true, 'A pass needs a phase, step, priority or empty-stack destination.');
const Sequence = { gameId: Uuid, cursor: Cursor, steps: z.array(z.union([Hold, Answer, PassUntil, YieldPriority])).min(1).max(12) };
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

function reply(res, status, code, message) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }));
}

function readToken(req) {
  return /^Bearer ([0-9A-Za-z._~+\/=-]{1,256})$/i.exec(req.headers.authorization ?? '')?.[1] ?? null;
}

function registerTools(mcp, { actor, getSeat, callProduct, reauthorize, allowedOrigins }) {
  function tool(name, description, inputSchema, scope, run, readOnlyHint = false) {
    if (['create_game', 'join_game', 'start_match', 'get_game_state', 'submit_decision', 'pass_until', 'play_sequence', 'submit_sequence'].includes(name)) {
      description += ` ${guideBootstrap}`;
    }
    if (['play_sequence', 'submit_sequence'].includes(name)) description += ` ${sequenceInstructions}`;
    const scopes = scope === 'catalog' ? ['play', 'library'] : [scope === 'decks' ? 'library' : scope];
    mcp.registerTool(name, { description, inputSchema, annotations: { readOnlyHint },
      _meta: { securitySchemes: scopes.map(value => ({ type: 'oauth2', scopes: [value] })) },
    }, async (args, extra) => {
      try {
        if (!actor.scopes.includes(scope)) throw new ToolError('forbidden', 'This credential lacks the required scope.');
        return textResult(await run(args, extra.signal));
      } catch (error) {
        if (error instanceof ToolError) return textResult({ code: error.code, message: error.message }, true);
        if (extra.signal.aborted) return textResult({ code: 'cancelled', message: 'The request was cancelled.' }, true);
        return textResult({ code: 'operation_failed', message: 'Playmat could not verify completion. Read the latest state before retrying.' }, true);
      }
    });
  }

  const fromProduct = (operation, args) => {
    if (!callProduct) throw new ToolError('unavailable', 'The product service is unavailable.');
    return callProduct(operation, args);
  };
  tool('get_game_state', 'Read the public battlefield and your own seat, hand, current decision and timing. secondsRemaining is a last reported cumulative match clock, not an inactivity countdown. A null clock or unknown inactivity deadline never means unlimited decision time; answer pending legal choices promptly.', { gameId: Uuid.optional() },
    'play', ({ gameId }) => getSeat().snapshot(gameId), true);
  tool('resync_game', 'Ask XMage for the current decision after a lost or uncertain acknowledgement.', { gameId: Uuid },
    'play', ({ gameId }) => getSeat().engine.resync(gameId));
  tool('wait_for_decision', 'Wait for a new engine-issued decision, sideboarding or game end. A timeout includes the current state and may still have an unanswered decision. Polling does not answer it or pause inactivity; resolve a pending choice before waiting for another.', {
    gameId: Uuid.optional(), afterDecisionId: StringId.optional(), afterCursor: Cursor.optional(),
    timeoutMs: z.number().int().min(100).max(25_000).optional(),
  }, 'play', (args, signal) => getSeat().wait(args, signal), true);
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
  const playSequence = (args) => getSeat().startSequence(args, reauthorize);
  tool('play_sequence', 'Queue guarded choices by exact ID, card or label. Mark a planned cast with expectCast to let later steps pay for that same spell.', Sequence, 'play', playSequence);
  tool('submit_sequence', 'Start a conditional, bounded sequence of choices, brief waits and ordinary passes.', Sequence, 'play', playSequence);
  tool('get_sequence_status', 'Check the progress and interruption reason for one plan.', { gameId: Uuid, sequenceId: Uuid }, 'play',
    (args) => getSeat().sequenceStatus(args), true);
  tool('cancel_sequence', 'Cancel unapplied steps without undoing moves already accepted by XMage.', { gameId: Uuid, sequenceId: Uuid }, 'play',
    (args) => getSeat().cancelSequence(args));

  tool('list_joinable_games', 'List only tables with an available invitation for this account.', { limit: z.number().int().min(1).max(50).default(25) },
    'play', (args) => fromProduct('list_joinable_games', args), true);
  tool('create_game', 'Create a private, unrated best-of-three table as this agent seat.', {
    format: Format, name: z.string().trim().min(1).max(80), deck: Deck,
    guestEngineName: z.string().trim().min(1).max(36),
  }, 'play', async ({ guestEngineName, ...args }) => getSeat().engine.createGame(args,
    (record) => fromProduct('create_game_invite', { ...record, guestEngineName })));
  tool('join_game', 'Join a private table from its Playmat invite link or table ID. Use a legal deck and an optional seat display name.', {
    tableId: Uuid.optional(), inviteLink: z.url().max(2048).optional(),
    displayName: z.string().trim().min(1).max(24).optional(), deck: Deck,
  }, 'play', async ({ tableId, inviteLink, displayName, deck }) => {
      if (Boolean(tableId) === Boolean(inviteLink)) throw new ToolError('invalid_invite', 'Provide either the invite link or the table ID.');
      if (inviteLink) {
        const url = new URL(inviteLink);
        const [, , id] = url.pathname.split('/');
        if (!allowedOrigins.includes(url.origin) || url.username || url.password || url.search || url.hash
          || url.pathname !== `/join/${id}` || !Uuid.safeParse(id).success) {
          throw new ToolError('invalid_invite', 'Provide the private link copied from this Playmat deployment.');
        }
        tableId = id;
      }
      const invitation = await fromProduct('inspect_game_invite', { tableId });
      return getSeat().engine.joinGame({ tableId, deck }, invitation,
        () => fromProduct('get_game_invite', { tableId, displayName }));
    });
  tool('start_match', 'Start your own private table when it is ready.', { tableId: Uuid }, 'play',
    (args) => getSeat().engine.startMatch(args.tableId));
  tool('concede', 'Concede this game or the whole match explicitly.', { gameId: Uuid, entireMatch: z.boolean().default(false) }, 'play',
    ({ gameId, entireMatch }) => getSeat().engine.concede(gameId, entireMatch));
  tool('get_sideboard_state', 'Read the private eligible card pool and state of your sideboarding step.', { gameId: Uuid.optional() }, 'play',
    ({ gameId }) => getSeat().engine.sideboardState(gameId), true);
  tool('submit_sideboard', 'Submit an engine-validated deck drawn from the registered card pool for the next game.', {
    gameId: Uuid, decisionId: StringId, deck: Deck,
  }, 'play', (args) => getSeat().engine.submitSideboard(args));
  tool('request_rollback', 'Ask the other player to approve a rewind to the start of a turn.', { gameId: Uuid, turnsBack: z.number().int().min(0).max(1) },
    'play', (args) => getSeat().engine.requestRollback(args));
  tool('vote_rollback', 'Vote on the one pending rollback request shown to your seat.', { gameId: Uuid, requestId: Uuid, accept: z.boolean() },
    'play', (args) => getSeat().engine.voteRollback(args));
  tool('list_chat', 'Read recent messages from the current match chat only.', { gameId: Uuid }, 'chat',
    ({ gameId }) => getSeat().engine.listChat(gameId), true);
  tool('send_chat', 'Send a chat message as this seat in its active match.', {
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
  tool('list_decks', 'List your private library deck revisions.', {}, 'decks', () => fromProduct('list_decks', {}), true);
  tool('get_deck', 'Read one deck in your library.', { deckId: Uuid }, 'decks', (args) => fromProduct('get_deck', args), true);
  tool('create_deck', 'Create a new private library deck.', { name: z.string().min(1).max(120), format: Format, deck: Deck },
    'decks', (args) => fromProduct('create_deck', args));
  tool('update_deck', 'Save a revision if your current deck revision still matches.', {
    deckId: Uuid, expectedRevision: z.number().int().positive(), name: z.string().min(1).max(120), format: Format, deck: Deck,
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
  tool('export_matches', 'Request an authorized download handle for selected games.', {
    gameIds: z.array(Uuid).min(1).max(10),
  }, 'history', (args) => fromProduct('export_matches', args));
}

export function createMcpServer({
  authorize, createEngine, product, eventRequest, publishSeatEvent, oauthResourceMetadata, allowedOrigins = [], maxSeats = 64,
}) {
  const seats = new Map();
  const seatWatchers = new Map();
  const server = createServer(async (req, res) => {
    const pathname = req.url?.split('?')[0];
    if (pathname === '/healthz' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
      res.end('ok');
      return;
    }
    if (pathname !== '/mcp') return reply(res, 404, -32601, 'Not found');
    const token = readToken(req);
    if (req.headers.origin && !allowedOrigins.includes(req.headers.origin)) return reply(res, 403, -32600, 'Origin not allowed');
    function unauthorized() {
      if (oauthResourceMetadata) res.setHeader('WWW-Authenticate', 'Bearer resource_metadata="' + oauthResourceMetadata + '"');
      return reply(res, 401, -32001, 'Unauthorized');
    }
    if (!token) return unauthorized();

    let actor;
    try { actor = await authorize(token); }
    catch { return reply(res, 503, -32000, 'Authorization service unavailable'); }
    if (!actor || !actor.accountId || !actor.engineName || !Array.isArray(actor.scopes)) return unauthorized();

    const seatKey = JSON.stringify([actor.accountId, actor.engineName]);
    function getSeat() {
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
    const mcp = new McpServer({ name: 'playmat-private', version: '0.1.0' }, { instructions: guideInstructions });
    const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true, sessionIdGenerator: undefined });
    registerGuides(mcp);
    if (eventRequest) registerEvents(mcp.server, actor, (method, args) => eventRequest(token, method, args));
    if (actor.scopes.includes('history')) registerMatchReviewPrompt(mcp);
    registerTools(mcp, {
      actor, getSeat, allowedOrigins,
      callProduct: product ? (operation, args) => product(token, operation, args) : null,
      reauthorize: async () => {
        const fresh = await authorize(token);
        return fresh?.accountId === actor.accountId && fresh.engineName === actor.engineName && fresh.scopes.includes('play');
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
