import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import WebSocket from 'ws';

const engineUrl = process.env.PLAYMAT_LIVE_ENGINE_URL;
const webUrl = process.env.PLAYMAT_LIVE_WEB_URL;
const PLAYER = {
  name: 'Human fixture deck', cards: [{ cardName: 'Forest', amount: 60 }],
  sideboard: [{ cardName: 'Mountain', amount: 1 }],
};
const COMPUTER = {
  name: 'Native AI fixture deck', cards: [
    { cardName: 'Mountain', amount: 56 },
    { cardName: 'Monastery Swiftspear', setCode: 'BRO', amount: 4 },
  ], sideboard: [],
};
const SIDEBOARDED = {
  name: PLAYER.name, cards: [{ cardName: 'Forest', amount: 59 }, { cardName: 'Mountain', amount: 1 }],
  sideboard: [{ cardName: 'Forest', amount: 1 }],
};

async function browserSession() {
  if (!webUrl) {
    const url = new URL(engineUrl);
    if (url.protocol !== 'ws:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
      throw new Error('The engine fixture must be a trusted loopback WebSocket.');
    }
    const userName = `AIFixture${randomBytes(2).toString('hex')}`;
    return { url: url.href, userName, headers: { 'X-Playmat-User': userName } };
  }

  const url = new URL(webUrl);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('The deployed browser fixture must be an HTTPS origin without credentials, query or fragment.');
  }
  const userName = process.env.PLAYMAT_LIVE_WEB_USERNAME;
  const password = process.env.PLAYMAT_LIVE_WEB_PASSWORD;
  if (!userName || !password) throw new Error('Provide a provisioned browser fixture account.');
  const signIn = await fetch(new URL('/login', url), {
    method: 'POST', redirect: 'manual', headers: { origin: url.origin },
    body: new URLSearchParams({ username: userName, password, next: '/' }),
  });
  assert.equal(signIn.status, 303, 'The provisioned browser fixture can sign in.');
  const cookie = signIn.headers.getSetCookie().find((header) => header.startsWith('__Host-playmat-session='))?.split(';', 1)[0];
  assert.ok(cookie, 'The browser sign-in issues a secure session cookie.');
  const ws = new URL('/ws', url);
  ws.protocol = 'wss:';
  return { url: ws.href, userName, headers: { Cookie: cookie, Origin: url.origin } };
}

async function until(condition, description, timeoutMs = 30_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const result = await condition();
    if (result) return result;
    await sleep(30);
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

function fixtureChoice(state) {
  const { interaction, view } = state;
  if (interaction.mode === 'priority') {
    for (const [id, command] of interaction.clickable) {
      if (view?.myHand?.[id]?.cardTypes?.includes('LAND')) return command;
    }
  }
  if (state.prompt?.kind === 'ask' && state.prompt.isMulligan) {
    const keep = [interaction.mainButton, ...interaction.secondaryButtons].find((button) => /^keep\b/i.test(button?.label ?? ''));
    if (keep) return keep.command;
  }
  return interaction.mainButton?.command ?? interaction.clickable.values().next().value;
}

function verify(result, message) {
  assert.equal(result === true, true, message);
}

test('[PM-AC-13] a provisioned browser seat plays a native XMage AI Bo3 without MCP', {
  skip: !engineUrl && !webUrl, timeout: 210_000,
}, async (t) => {
  const { createApi, RpcClient, EventBus, GameSession } = await import('../dist/engine-core.mjs');
  const connection = await browserSession();
  const rpc = new RpcClient({
    createSocket: (url) => new WebSocket(url, { headers: connection.headers }),
    heartbeatTimeoutMs: 30_000, requestTimeoutMs: 15_000, maxReconnectAttempts: 0,
  });
  const bus = new EventBus(rpc);
  const api = createApi(rpc);
  let activeSession;
  t.after(() => {
    activeSession?.dispose();
    bus.dispose();
    rpc.disconnect();
  });

  const starts = [];
  const sideboards = [];
  bus.on('START_GAME', (data) => starts.push(data));
  bus.on('SIDEBOARD', (data) => sideboards.push(data));

  await rpc.connect(connection.url);
  verify(await api.connectUser(connection.userName, '', null, 'web'), 'The browser identity is trusted by XMage.');
  const roomId = await api.serverGetMainRoomId();
  const format = 'Constructed - Pioneer';
  for (const deck of [PLAYER, COMPUTER]) {
    assert.equal((await api.deckValidate(format, deck)).valid === true, true, 'XMage accepts the registered starting deck.');
  }
  const password = randomUUID();
  const table = await api.roomCreateTable(roomId, {
    name: 'Native AI Bo3 acceptance fixture', gameType: 'Two Player Duel', deckType: format,
    playerTypes: ['HUMAN', 'COMPUTER_MAD'], winsNeeded: 2, rollbackTurnsAllowed: true,
    spectatorsAllowed: false, rated: false, password,
  });
  assert.ok(table.tableId);
  verify(await api.roomJoinTable(roomId, table.tableId, connection.userName, 'HUMAN', 1, PLAYER, password),
    'The browser account seats with its validated deck.');
  verify(await api.roomJoinTable(roomId, table.tableId, 'AI 1', 'COMPUTER_MAD', 4, COMPUTER, password),
    'The host seats the native AI without an invitation or second identity.');
  verify(await api.matchStart(roomId, table.tableId), 'The host starts the filled table.');

  const played = new Set();
  for (let game = 1; game <= 2; game++) {
    const start = await until(() => starts.shift(), 'the next game callback');
    assert.ok(start.gameId && start.playerId);
    assert.ok(!played.has(start.gameId), 'The next game has a distinct ID.');
    played.add(start.gameId);
    activeSession = new GameSession(api, bus, { gameId: start.gameId, playerId: start.playerId, mode: 'play' });
    verify(await api.gameJoin(start.gameId), 'The browser seat joins the game.');
    let nativeLandPlayed = false;
    let conceded = false;
    let nextResync = Date.now() + 6_000;
    const summary = await until(async () => {
      const state = activeSession.getState();
      const computer = state.view?.players?.find((player) => player.playerId !== start.playerId && player.isHuman === false);
      if (computer && Object.values(computer.battlefield ?? {}).some((card) => card.cardTypes?.includes('LAND'))) {
        nativeLandPlayed = true;
      }
      if (state.endInfo) return state.endInfo;
      if (state.gameOver) return false;
      if (nativeLandPlayed && !conceded) {
        conceded = true;
        // Finish deterministically after observing that the native seat has acted.
        await activeSession.respond({ type: 'action', action: 'CONCEDE' });
        return false;
      }
      if (state.awaitingServer || !state.prompt || state.stalled) {
        if (Date.now() > nextResync) {
          nextResync = Date.now() + 6_000;
          await activeSession.resync();
        }
        return false;
      }
      const command = fixtureChoice(state);
      if (command) await activeSession.respond(command);
      return false;
    }, 'the native AI to take a turn and win the fixture game', 65_000);
    assert.ok(nativeLandPlayed, 'The nonhuman seat took a real XMage land action before the fixture conceded.');
    assert.equal(summary.winsNeeded, 2);
    const aiWins = Math.max(summary.loses ?? 0, ...(summary.players ?? [])
      .filter((player) => player.playerId !== start.playerId).map((player) => player.wins ?? 0));
    assert.equal(aiWins, game);
    activeSession.dispose();
    activeSession = null;

    if (game === 1) {
      const sideboard = await until(() => sideboards.shift(), 'the human sideboard prompt');
      verify(await api.deckSubmit(sideboard.currentTableId ?? table.tableId, SIDEBOARDED),
        'The browser seat submits a legal sideboard while the engine controls the native AI seat.');
    }
  }
  assert.equal(played.size, 2);
  await api.disconnectSession(false).catch(() => {});
});
