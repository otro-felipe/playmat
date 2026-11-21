import { expect, test } from '@playwright/test';

test.skip(process.env.VITE_PRIVATE_PLAYTESTING !== 'true', 'private build only');

const gameId = '00000000-0000-4000-8000-0000000000ab';
const matchId = '00000000-0000-4000-8000-0000000000ac';
const playerA = '00000000-0000-4000-8000-0000000000ad';
const playerB = '00000000-0000-4000-8000-0000000000ae';
const privateHand = { fatal: { name: 'Fatal Push', id: 'fatal', cardTypes: ['INSTANT'], expansionSetCode: 'AER', cardNumber: '57' } };
const ownHand = { bolt: { name: 'Burst Lightning', id: 'bolt', cardTypes: ['INSTANT'], expansionSetCode: 'ZEN', cardNumber: '119' } };
const players = [
  { playerId: playerA, name: 'Alice', handCount: 1, life: 9, libraryCount: 39 },
  { playerId: playerB, name: 'Bob', handCount: 1, life: 13, libraryCount: 43, battlefield: {
    sheoldred: { name: 'Sheoldred, the Apocalypse', id: 'sheoldred', cardTypes: ['CREATURE'], expansionSetCode: 'DMU', cardNumber: '107', power: '4', toughness: '5' },
  } },
];
const board = { turn: 9, step: 'PRECOMBAT_MAIN', activePlayerName: 'Alice', activePlayerId: playerA, players };
const review = {
  status: 'partial', reviewed: 1, eligible: 6, counts: { good: 1 }, bySeat: [{ seatId: 'seat-a', name: 'Alice', reviewed: 1, counts: { good: 1 } }],
};
const perspectives = [{ seatId: 'seat-a', playerId: playerA, name: 'Alice', owned: true }, { seatId: 'seat-b', playerId: playerB, name: 'Bob', owned: false }];
const actual = {
  kind: 'cast', text: 'mcp_e70ebd2d48 casts Burst Lightning [28c] targeting Sheoldred [711]',
  cardRef: { id: 'bolt', name: 'Burst Lightning', setCode: 'ZEN', cardNumber: '119' },
  targets: [{ kind: 'card', id: 'sheoldred', name: 'Sheoldred, the Apocalypse', setCode: 'DMU', cardNumber: '107' }],
  modes: ['Kicker'], paidMana: { R: 1, C: 4 },
};
const stackBoard = { ...board, stack: { bolt: { ...ownHand.bolt, targets: ['sheoldred'] } } };
const castAction = { type: 'action', cursor: 6, frameCursor: 5, actionFrameCursor: 7, turn: 9, actor: 'Alice',
  seatId: 'seat-a', hasDecisionContext: true, actual, text: actual.text };
const castMode = {
  id: 'cast-mode', choiceKind: 'mode', optionDetails: [
    { id: 'regular', label: 'Sin kicker' }, { id: 'kick', label: 'Pagar kicker' },
  ], selectedOptionIds: ['kick'],
};
const title = 'Alice lanza Burst Lightning con Sheoldred, the Apocalypse como objetivo';
const annotation = {
  gameId, cursor: 6, frameCursor: 5, seatId: 'seat-a', category: 'good', confidence: 'high', actual,
  rationale: 'Sheoldred estaba en mesa y su disparo seguía amenazando.',
  alternatives: [{ line: 'Guardar el segundo Burst', legality: 'legal', benefit: 'Mantiene alcance', risk: 'Sheoldred sigue en mesa' }],
  evidence: { basis: 'engine_log', frameCursor: 5, turn: 9 },
  retrospective: 'Bob tenía Fatal Push en la mano.',
};
const otherAction = {
  kind: 'attack', text: 'Bob attacks with Llanowar Elves [abc] at Alice',
  cardRef: { name: 'Llanowar Elves' }, targets: [{ kind: 'player', id: playerA, name: 'Alice' }],
};
const otherNote = { ...annotation, actual: otherAction, cursor: 8, frameCursor: 7, category: 'inaccuracy', rationale: 'Fue mejor esperar.' };

for (const [device, viewport] of Object.entries({ desktop: { width: 1440, height: 960 }, mobile: { width: 390, height: 844 } })) {
  test.describe(device, () => {
    test.use({ viewport, isMobile: device === 'mobile', hasTouch: device === 'mobile' });
    test('[PM-REVIEW-UI-4] abrir y ocultar el análisis y ambas manos conserva el cursor del replay', async ({ page, baseURL }, testInfo) => {
      expect(['127.0.0.1', 'localhost', '[::1]']).toContain(new URL(baseURL!).hostname);
      await page.addInitScript(() => {
        localStorage.setItem('playmat.settings', JSON.stringify({ locale: 'es', sound: false, animations: false, matArt: 'none' }));
      });
      let archiveAvailable = true;
      await page.route('**/api/playtesting/**', async (route) => {
        const url = new URL(route.request().url());
        let data: unknown = {};
        if (url.pathname.endsWith('/me')) data = { engineName: 'Alice', agent: false };
        if (url.pathname.endsWith('/stats')) data = { groups: [] };
        if (url.pathname.endsWith('/matches')) data = { cursor: null, matches: [{
          id: matchId, name: 'Pioneer', format: 'Pioneer', status: 'completed', analysis: review,
          games: [{ gameId, gameNumber: 3, replayAvailable: true, archiveState: 'ready', players: [{ name: 'Alice' }, { name: 'Bob' }], analysis: review }],
        }] };
        if (url.pathname.endsWith(`/games/${gameId}`) && !archiveAvailable) {
          return route.fulfill({ status: 404, json: {} });
        }
        if (url.pathname.endsWith(`/games/${gameId}`)) data = {
          gameId, matchId, gameNumber: 3, status: 'completed', viewerSeatId: 'seat-a', fullAvailable: true, availablePerspectives: perspectives, analysis: review,
          coverage: { partial: false, draws: 1, hands: 'both_where_recorded' },
        };
        if (url.pathname.endsWith('/annotations')) data = { annotations: [annotation, otherNote], next: null };
        if (url.pathname.endsWith('/evidence') && url.searchParams.get('scope') === 'full'
          && url.searchParams.get('cursor') === '6' && url.searchParams.get('count') === '1') {
          return route.fulfill({ json: { events: [{ ...castAction, decisions: [castMode] }], next: null } });
        }
        if (url.pathname.endsWith('/evidence')) data = { next: null, events: url.searchParams.get('scope') === 'public'
          ? [castAction,
            { type: 'action', cursor: 8, frameCursor: 7, turn: 9, actor: 'Bob', actual: otherAction, text: otherAction.text }]
          : [{ type: 'draw', cursor: 4, frameCursor: 0, actorPlayerId: playerA, card: { id: 'bolt', name: 'Burst Lightning' } },
            ...[{ cursor: 5, view: board }, { cursor: 7, view: stackBoard }].map((frame) => ({
              ...frame, type: 'frame',
              myHand: url.searchParams.get('seatId') === 'seat-b' ? privateHand : ownHand,
              ...(url.searchParams.get('scope') === 'full' ? { hands: { [playerA]: ownHand, [playerB]: privateHand } } : {}),
            }))] };
        await route.fulfill({ json: data });
      });
      await page.routeWebSocket(/\/ws$/, (socket) => socket.onMessage((raw) => {
        const message = JSON.parse(String(raw));
        if (message.id === undefined) return;
        const results: Record<string, unknown> = {
          connectUser: true, sessionUserName: 'Alice', sessionGetRestoreToken: '',
          serverGetMainRoomId: '00000000-0000-4000-8000-0000000000aa',
          serverInfo: { signOn: 'Alice', signOnOnly: true, deckSync: true, accounts: false, serverName: 'Synthetic private server' },
          getServerState: { serverVersion: 'fixture', maxGameRuns: 0, cardInfo: [] },
          replayPage: { info: { gameId }, start: 0, total: 5, events: [
            { cursor: 0, view: { ...board, turn: 8 }, myHand: ownHand }, { cursor: 1, log: { message: 'Alice drew a card' } },
            { cursor: 5, view: board, myHand: ownHand }, { cursor: 6, log: { message: actual.text } },
            { cursor: 7, view: stackBoard, myHand: ownHand },
          ] },
          soloTurns: [],
        };
        socket.send(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: results[message.method] ?? null }));
      }));

      await page.goto(`/replay/${gameId}?frame=0`);
      const analysis = page.getByRole('switch', { name: 'Ver análisis' });
      const hands = page.getByRole('switch', { name: 'Ver ambas manos' });
      await expect(analysis).toHaveAttribute('aria-checked', 'false');
      await expect(hands).toHaveAttribute('aria-checked', 'true');
      const marker = page.getByRole('group', { name: 'Decisiones analizadas' }).getByRole('button', { name: '2 decisiones en este punto' });
      await marker.click();
      await page.getByRole('menuitem', { name: 'Imprecisión Bob ataca a Alice con Llanowar Elves' }).click();
      await expect(page.locator('[data-replay-cursor]')).toHaveAttribute('data-replay-cursor', '8');
      await marker.click();
      await page.getByRole('menuitem', { name: `Normal ${title}` }).click();
      await marker.focus();
      await marker.press('ArrowRight');
      await expect(page.locator('[data-replay-cursor]')).toHaveAttribute('data-replay-cursor', '8');
      await expect(marker).toBeFocused();
      await marker.press('ArrowLeft');
      await expect(page.locator('[data-replay-cursor]')).toHaveAttribute('data-replay-cursor', '6');
      await expect(page.getByRole('region', { name: 'Stack, 1 object' }).getByRole('listitem')).toHaveAttribute('aria-label', /Burst Lightning.*Sheoldred/);
      const decision = page.getByRole('region', { name: 'Decisión registrada' });
      await expect(decision.getByLabel('Normal')).toBeVisible();
      await expect(decision).toContainText('Kicker');
      await expect(decision).toContainText('Objetivos');
      const transport = await page.getByRole('toolbar', { name: 'Replay controls' }).boundingBox();
      const stage = await page.locator('[data-contained]').boundingBox();
      expect(transport!.y).toBeGreaterThanOrEqual(stage!.y + stage!.height - 1);
      await analysis.focus();
      await analysis.press('Space');
      await page.getByRole('navigation', { name: 'Momentos clave' }).getByRole('button', { name: new RegExp(title) }).click();
      await expect(page.getByText('Mantiene alcance')).toBeVisible();
      await expect(page.getByText('Confianza alta')).toBeVisible();
      const modes = page.getByRole('region', { name: 'Modos' });
      await expect(modes.getByText('Sin kicker')).toBeVisible();
      await expect(modes.getByRole('listitem').filter({ hasText: 'Pagar kicker' })).toContainText('Elegida');
      if (device === 'mobile') await page.keyboard.press('ArrowRight');
      await expect(page.locator('[data-replay-cursor]')).toHaveAttribute('data-replay-cursor', '6');
      await expect(page.getByRole('region', { name: 'Evidencia previa a la jugada' })).toHaveCount(0);
      const preview = page.getByRole('button', { name: 'Burst Lightning, ver carta' });
      await expect(preview).toHaveCSS('text-decoration-line', 'underline');
      if (device === 'desktop') await preview.hover();
      else await preview.tap();
      await expect(page.getByRole('tooltip')).toBeVisible();
      await page.keyboard.press('Escape');
      if (device === 'mobile') await page.keyboard.press('Escape');
      else await analysis.click();
      await expect(hands).toHaveAttribute('aria-checked', 'true');
      await expect(page.getByRole('group', { name: 'Mano registrada de Bob' }).getByRole('button', { name: 'Fatal Push' })).toBeVisible();
      await expect(page.locator('[data-replay-cursor]')).toHaveAttribute('data-replay-cursor', '6');
      await page.screenshot({ animations: 'disabled', path: testInfo.outputPath(`replay-hands-${device}.png`) });
      await analysis.click();
      await expect(page.getByText('Bob tenía Fatal Push en la mano.')).toBeVisible();
      await page.screenshot({ animations: 'disabled', path: testInfo.outputPath(`replay-analysis-${device}.png`) });
      if (device === 'mobile') {
        await expect(page.getByRole('dialog', { name: 'Análisis' })).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(analysis).toBeFocused();
      } else await analysis.click();
      await hands.click();
      await expect(page.getByRole('group', { name: 'Mano registrada de Bob' })).toHaveCount(0);
      await expect(page.locator('[data-replay-cursor]')).toHaveAttribute('data-replay-cursor', '6');
      await page.goto('/history');
      await page.getByRole('button', { name: /Bob/ }).click();
      await expect(page.getByText('1 de 6 jugadas revisadas')).toBeVisible();
      await page.getByText('Calificaciones por jugador y juego').click();
      await expect(page.getByRole('group', { name: 'Juego 3' }).getByText('Normal')).toBeVisible();

      archiveAvailable = false;
      await page.goto(`/replay/${gameId}?frame=0`);
      await expect(analysis).toHaveCount(0);
      const legacyTransport = await page.getByRole('toolbar', { name: 'Replay controls' }).boundingBox();
      const legacyStage = await page.locator('[data-contained]').boundingBox();
      expect(legacyTransport!.y).toBeGreaterThanOrEqual(legacyStage!.y + legacyStage!.height - 1);
    });
  });
}
