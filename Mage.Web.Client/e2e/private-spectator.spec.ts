import { expect, test, type Page } from '@playwright/test';
import { spectatorSnapshot, spectatorToken } from './fixtures/spectatorSnapshot';

test.skip(process.env.VITE_PRIVATE_PLAYTESTING !== 'true', 'private playtesting routes');
test.beforeEach(async ({ page, baseURL }) => {
  expect(['127.0.0.1', 'localhost', '[::1]']).toContain(new URL(baseURL!).hostname);
  await page.addInitScript(() => localStorage.setItem('playmat.settings', JSON.stringify({
    locale: 'es', animations: false, matArt: 'none', hideHands: true,
  })));
});

for (const viewport of [{ width: 1512, height: 805 }, { width: 390, height: 844 }]) {
  test.describe(`spectator ${viewport.width}px`, () => {
    test.use({ viewport });
    test('a public link opens the real board with two visible hands and no player connection', async ({ page }, info) => {
      const privateRequests: string[] = [];
      page.on('websocket', socket => {
        const path = new URL(socket.url()).pathname;
        // Vite's development hot reload is separate from the game transport.
        if (path !== '/' || process.env.MAGE_WEB_E2E_PREVIEW === '1') privateRequests.push(path);
      });
      await page.route('**/api/playtesting/**', route => {
        const path = new URL(route.request().url()).pathname;
        if (path === '/api/playtesting/spectate/' + spectatorToken) return route.fulfill({ json: spectatorSnapshot });
        if (path.endsWith('/events')) return route.fulfill({ status: 200, contentType: 'text/event-stream', body: 'retry: 5000\n\n' });
        privateRequests.push(path);
        return route.fulfill({ status: 403, json: {} });
      });
      await page.goto('/watch/' + spectatorToken);
      const header = page.getByRole('banner', { name: 'Transmisión de la partida' });
      await expect(header.getByRole('heading', { name: 'Modo espectador' })).toBeVisible();
      await expect(page.getByRole('listitem', { name: 'Forest', exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Lightning Bolt', exact: true })).toBeVisible();
      const stage = page.locator('[data-layout]').first();
      await expect(stage).toBeVisible();
      const toolbarBox = await header.boundingBox();
      const boardBox = await stage.locator('..').boundingBox();
      expect(toolbarBox!.y + toolbarBox!.height).toBeLessThanOrEqual(boardBox!.y + 1);
      await expect(page.getByRole('button', { name: /Concede|Conceder|Game menu|Actualizar tablero|Ask to see/i })).toHaveCount(0);
      await page.keyboard.press('Space');
      expect(privateRequests).toEqual([]);
      for (const handCard of [page.getByRole('listitem', { name: 'Forest', exact: true }), page.getByRole('button', { name: 'Lightning Bolt', exact: true })]) {
        await expect.poll(() => handCard.evaluate(card => {
          const image = card.querySelector('img');
          const frame = card.querySelector('[class*="titleBar"]')?.parentElement;
          return !!(image?.complete && image.naturalWidth || frame && Number(getComputedStyle(frame).opacity) > 0.95);
        })).toBe(true);
      }
      await page.screenshot({ path: info.outputPath(`espectador-${viewport.width}.png`) });
    });
  });
}

test('the public MCP board shows held cards as backs from their public counts', async ({ page }) => {
  const frame = { ...spectatorSnapshot, visibility: 'public-board', hands: {}, lines: [], chat: [] };
  await page.route('**/api/playtesting/spectate/**', route => route.request().url().endsWith('/events')
    ? route.fulfill({ contentType: 'text/event-stream', body: 'retry: 5000\n\n' })
    : route.fulfill({ json: frame }));
  await page.goto('/watch/' + spectatorToken);
  await expect(page.getByRole('listitem', { name: 'Hidden card', exact: true })).toHaveCount(1);
  await expect(page.getByRole('listitem', { name: 'Forest', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Lightning Bolt', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Copiar enlace de espectador' })).toHaveAttribute('title', /tablero/i);
});

test('an expired spectator link shows a clear message without visiting player login', async ({ page }) => {
  await page.route('**/api/playtesting/spectate/**', route => route.fulfill({ status: 404, json: {} }));
  await page.goto('/watch/' + spectatorToken);
  await expect(page.getByText('Este enlace de espectador ya no está disponible.')).toBeVisible();
  await expect(page).toHaveURL(new RegExp('/watch/' + spectatorToken + '$'));
});

test('the delegated owner watches both hands and creates the share link on request', async ({ page, context, baseURL }) => {
  const { gameId, tableId } = spectatorSnapshot;
  const frame = { ...spectatorSnapshot, humanMcpName: 'Alice',
    players: [spectatorSnapshot.players[0], { ...spectatorSnapshot.players[1], name: 'mcp_guest', displayName: 'Merlín' }],
    view: { ...spectatorSnapshot.view, players: [spectatorSnapshot.view.players[0], { ...spectatorSnapshot.view.players[1], name: 'mcp_guest' }] },
  };
  const posts: string[] = [];
  let startGame: (() => void) | undefined;
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.route('**/api/playtesting/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/spectator-link')) {
      posts.push(route.request().method() + ' ' + path);
      return route.fulfill({ json: { path: '/watch/' + spectatorToken } });
    }
    if (path.endsWith('/spectator') || path.endsWith('/spectate/' + spectatorToken)) return route.fulfill({ json: frame });
    if (path.endsWith('/events')) return route.fulfill({ contentType: 'text/event-stream', body: 'retry: 5000\n\n' });
    if (path.endsWith('/human-seat/' + tableId)) return route.fulfill({ json: { tableId, humanName: 'Alice', humanMcpAllowed: true } });
    return route.fulfill({ json: path.endsWith('/me') ? { engineName: 'Alice', agent: false } : { decks: [] } });
  });
  await page.routeWebSocket(/\/ws$/, socket => {
    socket.onMessage(raw => {
      const rpc = JSON.parse(String(raw));
      if (rpc.id === undefined) return;
      const result: Record<string, unknown> = { connectUser: true, sessionUserName: 'Alice', sessionGetRestoreToken: '',
        serverGetMainRoomId: '00000000-0000-4000-8000-0000000000aa', serverInfo: { signOn: 'Alice', signOnOnly: true },
        getServerState: { serverVersion: 'fixture', cardInfo: [] } };
      socket.send(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: result[rpc.method] ?? null }));
    });
    startGame = () => socket.send(JSON.stringify({ method: 'START_GAME', messageId: 1, objectId: tableId,
      data: { currentTableId: tableId, gameId, playerId: 'seat-a' } }));
  });
  await page.goto('/decks');
  await expect(page.getByRole('button', { name: 'Mis mazos', exact: true })).toBeVisible();
  startGame!();
  await expect(page).toHaveURL(new RegExp('/game/' + gameId));
  await expect(page.getByRole('button', { name: 'Lightning Bolt', exact: true })).toBeVisible();
  await expect(page.getByText(/Jugador controlado por MCP · Solo lectura/)).toBeVisible();
  const humanPlate = page.locator('[data-object-id="seat-a"]');
  const rivalPlate = page.locator('[data-object-id="seat-b"]');
  await expect(humanPlate).toContainText('Alice');
  await expect(humanPlate).toContainText('MCP habilitado');
  await expect(rivalPlate).toContainText('Merlín');
  await expect(rivalPlate).toContainText('MCP');
  expect(posts).toEqual([]);
  await page.getByRole('button', { name: 'Copiar enlace de espectador' }).click();
  expect(posts).toEqual(['POST /api/playtesting/tables/' + tableId + '/spectator-link']);
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(baseURL + '/watch/' + spectatorToken);
  await page.goto('/watch/' + spectatorToken);
  await expect(humanPlate).toContainText('MCP habilitado');
  await expect(rivalPlate).toContainText('Merlín');
});

for (const visibility of ['both-hands','public-board'] as const) test(`observer knowledge follows the server-issued ${visibility} scope`, async ({page}) => {
  const frame={...spectatorSnapshot,visibility,
    lines:[{at:1,playerId:'seat-a',playerName:'Alice',lineId:'new',audience:'public',explanation:'Explicación pública confirmada'},
      {at:2,playerId:'seat-b',playerName:'Bob',lineId:'legacy',reasoning:'Legacy original-scope fixture'}],
    chat:visibility==='both-hands' ? [{at:3,messageId:'talk',playerName:'Bob',message:'Comentario real de mesa'}] : [],
    seatKnowledge:{
    'seat-a':{lookedAt:[{cards:{a:{name:'Synthetic Look'}}}],revealed:[],topCard:{name:'Synthetic Top'}},
    'seat-b':{lookedAt:[],revealed:[{cards:{a:{name:'Synthetic Reveal'},b:{name:'Face-down fixture',faceDown:true}}}]}
  }};
  const queries:string[]=[];
  await page.route('**/api/playtesting/**',route=>{
    const path=new URL(route.request().url()).pathname; queries.push(path);
    return path.endsWith('/events')?route.fulfill({contentType:'text/event-stream',body:'retry: 30000\n\n'}):route.fulfill({json:frame});
  });
  await page.goto('/watch/'+spectatorToken);
  await expect(page.getByRole('heading',{name:'Modo espectador'})).toBeVisible();
  const known=page.getByRole('button',{name:'Cartas conocidas por cada asiento'});
  if(visibility==='both-hands'){
    await expect(page.getByRole('listitem',{name:'Forest',exact:true})).toBeVisible();
    await known.click();
    const dialog=page.getByRole('dialog',{name:'Cartas conocidas por cada asiento'});
    const mine=dialog.locator('section').filter({has:page.getByRole('heading',{name:'Alice'})});
    await expect(mine).toContainText('Synthetic Look'); await expect(mine).toContainText('Synthetic Top');
    await expect(mine).not.toContainText('Synthetic Reveal');
    await expect(dialog.locator('section').filter({has:page.getByRole('heading',{name:'Bob'})})).toContainText('Synthetic Reveal');
    await expect(dialog.getByText('Face-down fixture')).toHaveCount(0);
    await page.keyboard.press('Escape'); await expect(known).toBeFocused();
  }else{
    await expect(known).toHaveCount(0);
    await expect(page.getByRole('button',{name:'Lightning Bolt',exact:true})).toHaveCount(0);
    await expect(page.getByRole('listitem',{name:'Forest',exact:true})).toHaveCount(0);
  }
  await page.getByRole('button',{name:'Chat',exact:true}).click();
  const event=page.getByRole('button',{name:'El agente envió una línea de juego'});
  await expect(event).toHaveCount(1);
  await expect(page.getByText('Comentario real de mesa')).toHaveCount(visibility==='both-hands'?1:0);
  await event.click();
  await expect(page.getByRole('dialog').getByText('Explicación pública confirmada')).toBeVisible();
  await expect(page.getByText('Legacy original-scope fixture')).toHaveCount(0);
  expect(queries.every(p=>p.startsWith('/api/playtesting/spectate/'+spectatorToken))).toBe(true);
});

test('an owner switches link visibility with keyboard before sharing an opted-in MCP table', async ({page,context}) => {
  const {tableId}=spectatorSnapshot;
  await context.grantPermissions(['clipboard-read','clipboard-write']);
  const issued:string[]=[];
  await page.route('**/api/playtesting/**', route=>{
    const url=new URL(route.request().url());
    if(url.pathname.endsWith('/spectator-links')) return route.fulfill({json:{tables:[
      {tableId,tableName:'Mesa opt-in',spectatorVisibility:'both-hands'}, {tableId:'public-fixture',tableName:'Sólo público'}]}});
    if(url.pathname.endsWith('/spectator-link')){
      issued.push(url.search);return route.fulfill({json:{path:url.search?'/watch/expanded-fixture':'/watch/public-fixture'}});
    }
    return route.fulfill({json:url.pathname.endsWith('/me')?{engineName:'Alice',agent:false}:{decks:[]}});
  });
  await ownerConnection(page);
  await page.goto('/tables');
  const row=page.getByRole('article').filter({has:page.getByRole('heading',{name:'Mesa opt-in'})});
  const toggle=row.getByRole('switch',{name:'Compartir ambas manos en este enlace de espectador'});
  await expect(toggle).toHaveAttribute('aria-checked','false');
  await toggle.focus();await page.keyboard.press('Space');
  await expect(toggle).toHaveAttribute('aria-checked','true');
  await expect(row.getByText(/Quien tenga este enlace/)).toBeVisible();
  await row.getByRole('button',{name:'Copiar enlace de espectador'}).click();
  expect(issued).toEqual(['?visibility=both-hands']);
  await toggle.focus();await page.keyboard.press('Enter');
  await expect(toggle).toHaveAttribute('aria-checked','false');
  await expect(page.getByRole('article').filter({hasText:'Sólo público'}).getByRole('switch')).toHaveCount(0);
});

test('a finished expanded observer can follow only the same-table public link authorized by the server', async ({page}) => {
  const publicPath='/watch/ordinary-synthetic-finished';
  await page.route('**/api/playtesting/spectate/**', route=>{
    const path=new URL(route.request().url()).pathname;
    return route.fulfill({json:path.endsWith(spectatorToken)?
      {role:'spectator',visibility:'closed',status:'finished',publicPath}:
      {...spectatorSnapshot,visibility:'public-board',status:'finished',hands:{},lines:[],chat:[]}});
  });
  await page.goto('/watch/'+spectatorToken);
  await page.getByRole('link',{name:'Ver tablero público'}).click();
  await expect(page).toHaveURL(new RegExp(publicPath+'$'));
  await expect(page.getByRole('heading',{name:'Modo espectador'})).toBeVisible();
  await expect(page.getByRole('listitem',{name:'Forest',exact:true})).toHaveCount(0);
});

test('a closed observer drops the private board on its final SSE frame and cannot navigate to a foreign URL', async ({page}) => {
  const closed={role:'spectator',visibility:'closed',status:'finished',publicPath:'https://invalid.example/watch/fake'};
  await page.route('**/api/playtesting/spectate/**',route=>route.request().url().endsWith('/events')
    ?route.fulfill({contentType:'text/event-stream',body:'event: snapshot\ndata: '+JSON.stringify(closed)+'\n\n'})
    :route.fulfill({json:{...spectatorSnapshot,visibility:'both-hands'}}));
  await page.goto('/watch/'+spectatorToken);
  await expect(page.getByText('Este enlace de espectador ya no está disponible.')).toBeVisible();
  await expect(page.getByRole('listitem',{name:'Forest',exact:true})).toHaveCount(0);
  await expect(page.getByRole('link',{name:'Ver tablero público'})).toHaveCount(0);
});

async function ownerConnection(page: Page) {
  await page.routeWebSocket(/\/ws$/,socket=>socket.onMessage(raw=>{
    const rpc=JSON.parse(String(raw));if(rpc.id===undefined)return;
    const result:Record<string,unknown>={connectUser:true,sessionUserName:'Alice',sessionGetRestoreToken:'',
      serverGetMainRoomId:'00000000-0000-4000-8000-0000000000aa',serverInfo:{signOn:'Alice',signOnOnly:true},roomGetAllTables:[],roomGetFinishedGames:[],roomGetUsers:[],getServerState:{serverVersion:'fixture',cardInfo:[]}};
    socket.send(JSON.stringify({jsonrpc:'2.0',id:rpc.id,result:result[rpc.method]??null}));
  }));
}

for (const width of [390, 1440]) test(`owner configures a waiting MCP table before sharing, at ${width}px`, async ({page}, info) => {
  await page.setViewportSize({width,height:width===390?844:900});
  const {tableId}=spectatorSnapshot;
  let visibility: 'public-board'|'both-hands'='public-board';
  let locked=false;
  const mutations:string[]=[];
  const links:string[]=[];
  await page.route('**/api/playtesting/**', async route => {
    const {pathname,search}=new URL(route.request().url());
    if(pathname.endsWith('/spectator-links')) return route.fulfill({json:{tables:[
      {tableId, tableName:'Golgari vs. Mono-Red', spectatorVisibility:visibility, canConfigureSpectatorVisibility:!locked}
    ]}});
    if(pathname.endsWith('/spectator-link') && route.request().method()==='PATCH'){
      const desired=route.request().postDataJSON().spectatorVisibility;
      mutations.push(desired);
      if(locked)return route.fulfill({status:409,json:{}});
      visibility=desired;
      return route.fulfill({json:{tableId,spectatorVisibility:visibility}});
    }
    if(pathname.endsWith('/spectator-link')){
      links.push(search);
      return route.fulfill({json:{path:search?'/watch/expanded-synthetic':'/watch/public-synthetic'}});
    }
    return route.fulfill({json:pathname.endsWith('/me')?{engineName:'Alice',agent:false}:{decks:[]}});
  });
  await ownerConnection(page);
  await page.goto('/tables');
  const row=page.getByRole('article').filter({has:page.getByRole('heading',{name:'Golgari vs. Mono-Red'})});
  const config=row.getByRole('switch',{name:'Mostrar ambas manos a los espectadores'});
  const sharing=row.getByRole('switch',{name:'Compartir ambas manos en este enlace de espectador'});
  await expect(config).toHaveAttribute('aria-checked','false');
  await expect(sharing).toHaveCount(0);
  await config.focus(); await page.keyboard.press('Space');
  await expect(sharing).toHaveAttribute('aria-checked','false');
  await expect(config).toHaveAttribute('aria-checked','true');
  await page.reload();
  await expect(config).toHaveAttribute('aria-checked','true');
  await expect(sharing).toHaveAttribute('aria-checked','false');
  await expect(row.getByText(/Quien reciba el enlace ampliado/)).toBeVisible();
  expect(await row.evaluate(el=>el.scrollWidth<=el.clientWidth+1)).toBe(true);
  await config.focus();
  await row.screenshot({path:info.outputPath(`configurar-ambas-manos-${width}.png`),animations:'disabled'});
  await config.click();
  await expect(sharing).toHaveCount(0);
  await page.reload();
  await expect(config).toHaveAttribute('aria-checked','false');
  locked=true; // A guest claims the invitation after the last list fetch.
  await config.focus(); await page.keyboard.press('Enter');
  await expect(row.getByRole('alert')).toContainText('bloqueada');
  await expect(config).toHaveCount(0); await expect(sharing).toHaveCount(0);
  expect(mutations).toEqual(['both-hands','public-board','both-hands']);
  expect(links).toEqual([]);
});
