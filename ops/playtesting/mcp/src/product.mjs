import { randomUUID } from 'node:crypto';
import { McpError } from '@modelcontextprotocol/sdk/types.js';
import { ToolError } from './game-seat.mjs';

export function createProductClient(baseUrl, publicUrl) {
  const base = new URL(baseUrl);
  if (!['127.0.0.1', '::1', '[::1]', 'localhost'].includes(base.hostname)) {
    throw new Error('The Playmat product service must bind on loopback.');
  }

  async function request(token, path, { method = 'GET', body } = {}) {
    return fetch(new URL(path, base), {
      method, redirect: 'error', signal: AbortSignal.timeout(12_000),
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  async function authorize(token) {
    const reply = await request(token, '/internal/verify');
    if ([401, 403, 404].includes(reply.status)) return null;
    if (!reply.ok) throw new Error('Playmat authorization service unavailable.');
    const actor = await reply.json();
    if (!Array.isArray(actor.scopes)) return null;
    const scopes = new Set(actor.scopes);
    if (scopes.has('play') || scopes.has('library')) scopes.add('catalog');
    if (scopes.has('library')) scopes.add('decks');
    return { ...actor, scopes: [...scopes] };
  }

  async function operation(token, name, args) {
    const encode = encodeURIComponent;
    const root = '/api/playtesting';
    let path;
    let config;
    switch (name) {
      case 'list_joinable_games':
        path = `${root}/invites?limit=${args.limit}`;
        break;
      case 'inspect_game_invite':
        path = `${root}/invites/${encode(args.tableId)}`;
        break;
      case 'get_game_invite':
        path = `${root}/invites/${encode(args.tableId)}/claim`;
        config = { method: 'POST', body: { displayName: args.displayName } };
        break;
      case 'create_game_invite':
        path = `${root}/invites`;
        config = { method: 'POST', body: args };
        break;
      case 'list_decks':
        path = `${root}/decks?library=agent`;
        break;
      case 'get_deck':
        path = `${root}/decks/${encode(args.deckId)}`;
        break;
      case 'create_deck':
      case 'update_deck':
        path = `${root}/decks/${args.deckId ? encode(args.deckId) : randomUUID()}`;
        config = {
          method: 'PUT',
          body: { name: args.name, format: args.format, data: args.deck, expectedRevision: args.expectedRevision ?? 0 },
        };
        break;
      case 'list_matches': {
        const params = new URLSearchParams({ limit: String(args.limit) });
        if (args.format) params.set('format', args.format);
        if (args.cursor) params.set('cursor', args.cursor);
        path = `${root}/matches?${params}`;
        break;
      }
      case 'get_match':
        path = `${root}/matches/${encode(args.matchId)}`;
        break;
      case 'get_replay':
        path = `${root}/replays/${encode(args.gameId)}?start=${args.start}&count=${args.count}`;
        break;
      case 'evaluate_match':
        path = `${root}/evaluations/${encode(args.gameId)}?start=${args.start}&count=${args.count}`;
        break;
      case 'score_match_evaluation':
        path = `${root}/evaluations/${encode(args.gameId)}`;
        config = { method: 'POST', body: { positions: args.positions } };
        break;
      case 'get_match_review':
        path = args.matchId ? `${root}/review/matches/${encode(args.matchId)}` : `${root}/review/games/${encode(args.gameId)}`;
        break;
      case 'read_review_evidence':
      case 'list_review_annotations': {
        const { gameId, ...values } = args;
        const params = new URLSearchParams(Object.entries(values).filter(([, value]) => value !== undefined));
        const resource = name === 'read_review_evidence' ? 'evidence' : 'annotations';
        path = `${root}/review/games/${encode(gameId)}/${resource}?${params}`;
        break;
      }
      case 'save_review_annotations':
        path = `${root}/review/games/${encode(args.gameId)}/annotations`;
        config = { method: 'POST', body: { archiveRevision: args.archiveRevision, entries: args.entries } };
        break;
      case 'export_matches':
        path = `${root}/exports`;
        config = { method: 'POST', body: { gameIds: args.gameIds, mode: 'handle' } };
        break;
      default:
        throw new ToolError('invalid_operation', 'No such Playmat operation.');
    }
    const response = await request(token, path, config);
    if (!response.ok) {
      if (response.status === 409 && path.startsWith(root + '/review/')) {
        const result = await response.json().catch(() => null);
        if (result?.error === 'Wait for the completed match and its replay archive' || result?.error === 'Replay is not ready for review') {
          throw new ToolError('review_not_ready', 'Wait for the whole match and its replay archive.');
        }
        throw new ToolError('review_conflict', 'Read the current archive and annotation revisions before retrying.');
      }
      if (response.status === 409 && (name === 'evaluate_match' || name === 'score_match_evaluation')) {
        throw new ToolError('replay_not_ready', 'Wait for the completed game to be archived.');
      }
      const known = {
        400: ['invalid_input', 'The requested operation did not accept the supplied inputs.'],
        401: ['unauthorized', 'The credential is no longer authorized.'],
        403: ['forbidden', 'This account does not have permission for that operation.'],
        404: ['not_found', 'That authorized resource is unavailable.'],
        409: ['revision_conflict', 'The revision or invitation changed. Read the latest state before retrying.'],
        413: ['too_large', 'Request a smaller export.'],
      }[response.status] ?? ['product_unavailable', 'The product service could not verify completion.'];
      throw new ToolError(...known);
    }
    const data = response.status === 204 ? { accepted: true } : await response.json();
    if (name === 'export_matches' && typeof data.path === 'string' && data.path.startsWith('/api/playtesting/')) {
      return { ...data, ...(publicUrl ? { downloadUrl: new URL(data.path, publicUrl).href } : {}) };
    }
    if (name === 'create_game_invite' && data.tableId === args.tableId) {
      return { ...data, inviteLink: publicUrl ? new URL(`/join/${encode(args.tableId)}`, publicUrl).href : `/join/${encode(args.tableId)}` };
    }
    if (name === 'get_game_invite') return data.invite ?? data;
    return data;
  }

  async function eventRequest(token, method, params) {
    const response = await request(token, '/internal/mcp-events/' + method, { method: 'POST', body: params });
    const data = await response.json();
    if (response.ok) return data;
    if (data.rpcCode === -32015) throw new McpError(-32015, 'Callback verification failed', { reason: data.reason });
    if (response.status < 500) throw new McpError(-32602, data.error ?? 'Invalid event request.');
    throw new McpError(-32603, 'The Playmat event service is unavailable.');
  }

  async function publishSeatEvent(operation, payload) {
    const response = await fetch(new URL('/internal/mcp-events/seat', base), {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(3500),
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ operation, ...payload }),
    });
    await response.body?.cancel();
    if (!response.ok) throw Error('The Playmat event service did not accept the game decision.');
  }

  return { authorize, operation, eventRequest, publishSeatEvent };
}
