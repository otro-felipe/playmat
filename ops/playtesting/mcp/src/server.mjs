import { createServer } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { GameSeat, ToolError } from './game-seat.mjs';
import { listArchetypes, possibleResponses, searchCards } from './catalog.mjs';

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
const Answer = z.object({
  kind: z.literal('answer'), choiceId: StringId, decisionId: StringId.optional(),
  guard: z.object({ kind: StringId, ...GameCondition }).strict().optional(), value: Value.optional(),
}).strict().refine((value) => value.decisionId || (value.guard && hasDestination(value.guard)),
  'A planned answer needs the exact decision ID or a guard with its expected kind and destination.');
const PassUntil = z.object({
  kind: z.literal('pass_until'), ...GameCondition, skipOptionalResponses: z.boolean().default(false),
}).strict().refine(hasDestination, 'A pass needs a phase, step or priority destination.');
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

function registerTools(mcp, { actor, getSeat, callProduct, reauthorize }) {
  function tool(name, description, inputSchema, scope, run, readOnlyHint = false) {
    mcp.registerTool(name, { description, inputSchema, annotations: { readOnlyHint } }, async (args, extra) => {
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
  tool('get_game_state', 'Read the public battlefield and your own seat, hand and current decision.', { gameId: Uuid.optional() },
    'play', ({ gameId }) => getSeat().snapshot(gameId), true);
  tool('resync_game', 'Ask XMage for the current decision after a lost or uncertain acknowledgement.', { gameId: Uuid },
    'play', ({ gameId }) => getSeat().engine.resync(gameId));
  tool('wait_for_decision', 'Wait for a new engine-issued decision, sideboarding or game end.', {
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
  tool('submit_sequence', 'Start a conditional, bounded sequence of choices, waits on your decision clock and ordinary passes.', {
    gameId: Uuid, cursor: Cursor, steps: z.array(z.union([Hold, Answer, PassUntil])).min(1).max(12),
  }, 'play', (args) => getSeat().startSequence(args, reauthorize));
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
  tool('join_game', 'Redeem an invitation assigned to this account and register a legal deck on the agent seat.', { tableId: Uuid, deck: Deck },
    'play', async (args) => {
      const grant = await fromProduct('get_game_invite', { tableId: args.tableId });
      return getSeat().engine.joinGame(args, grant);
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
    name: z.string().min(1).max(250), setCode: z.string().max(12).optional(), cardNumber: z.string().max(20).optional(),
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
  tool('export_matches', 'Request an authorized download handle for selected games.', {
    gameIds: z.array(Uuid).min(1).max(10),
  }, 'history', (args) => fromProduct('export_matches', args));
}

export function createMcpServer({ authorize, createEngine, product, allowedOrigins = [], maxSeats = 64 }) {
  const seats = new Map();
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
    if (!token) return reply(res, 401, -32001, 'Unauthorized');

    let actor;
    try { actor = await authorize(token); }
    catch { return reply(res, 503, -32000, 'Authorization service unavailable'); }
    if (!actor || !actor.accountId || !actor.engineName || !Array.isArray(actor.scopes)) return reply(res, 401, -32001, 'Unauthorized');

    const seatKey = JSON.stringify([actor.accountId, actor.engineName]);
    function getSeat() {
      if (!seats.has(seatKey)) {
        if (seats.size >= maxSeats) throw new ToolError('capacity', 'The beta seat limit has been reached.');
        seats.set(seatKey, new GameSeat(createEngine(actor)));
      }
      return seats.get(seatKey);
    }
    const mcp = new McpServer({ name: 'playmat-private', version: '0.1.0' });
    const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true, sessionIdGenerator: undefined });
    registerTools(mcp, {
      actor, getSeat,
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
    for (const seat of seats.values()) {
      seat.invalidate('process_closed');
      seat.engine.close?.();
    }
  });
  return server;
}
