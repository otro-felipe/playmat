import { randomUUID } from 'node:crypto';
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
        path = `${root}/decks`;
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
      case 'export_matches':
        path = `${root}/exports`;
        config = { method: 'POST', body: { gameIds: args.gameIds, mode: 'handle' } };
        break;
      default:
        throw new ToolError('invalid_operation', 'No such Playmat operation.');
    }
    const response = await request(token, path, config);
    if (!response.ok) {
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

  return { authorize, operation };
}
