import { expect, test, type Page } from '@playwright/test';

const tableId = '11111111-1111-4111-8111-111111111111';
const tableName = 'Liga del Valle · Entrenamiento de Pioneer del lunes por la tarde';
const hostName = 'LunaDelValle';

test.skip(process.env.VITE_PRIVATE_PLAYTESTING !== 'true', 'requires the private playtesting build');
test.beforeEach(({baseURL}) => {
  if (!baseURL || !['127.0.0.1','localhost','[::1]'].includes(new URL(baseURL).hostname)) {
    throw Error('The owner-row fixture runs only on loopback');
  }
});

async function ownerLobby(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem('playmat.settings', JSON.stringify({locale: 'es', sound: false, animations: false}));
  });
  await page.route('**/api/playtesting/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (path.includes('/human-seat/')) return route.fulfill({status:404,json:{}});
    const response = path.endsWith('/me') ? {engineName:hostName, agent:false}
      : path.endsWith('/spectator-links') ? {tables:[]}
        : path.endsWith('/invites/'+tableId) ? {mode:'mcp', allowExternalMcp:true, guestEngineName:null, guestDisplayName:null}
          : {decks:[]};
    return route.fulfill({json:response});
  });
  await page.routeWebSocket(/\/ws$/, socket => socket.onMessage(raw => {
    const rpc = JSON.parse(String(raw));
    if (rpc.id === undefined) return;
    const results: Record<string,unknown> = {
      connectUser:true, sessionUserName:hostName, sessionGetRestoreToken:'',
      serverGetMainRoomId:'22222222-2222-4222-8222-222222222222', serverInfo:{signOn:hostName,signOnOnly:true},
      getServerState:{serverVersion:'fixture',cardInfo:[]}, roomGetFinishedGames:[],roomGetUsers:[],
      roomGetAllTables:[{tableId,tableName,controllerName:hostName,tableState:'WAITING',passworded:true,
        gameType:'Two Player Duel',deckType:'Constructed - Pioneer',
        seats:[{playerName:hostName,playerType:'HUMAN'},{playerName:null,playerType:'HUMAN'}]}],
    };
    socket.send(JSON.stringify({jsonrpc:'2.0',id:rpc.id,result:results[rpc.method]??null}));
  }));
}

for (const viewport of [{width:1698,height:1440},{width:849,height:720},{width:390,height:844}]) {
  test('owner table details and actions stay readable at '+viewport.width, async ({page}, info) => {
    await page.setViewportSize(viewport);
    await ownerLobby(page);
    await page.goto('/tables');
    await expect(page.getByRole('heading',{name:'Mesas abiertas'})).toBeVisible();
    await expect(page.getByRole('heading',{name:'Tus mesas'})).toBeVisible();
    await expect(page.getByRole('button',{name:'Crear una mesa'})).toBeVisible();
    await expect(page.getByRole('link',{name:'Recuperar partidas privadas'})).toBeVisible();
    await expect(page.getByRole('heading',{name:'Partidas en curso'})).toBeAttached();
    await expect(page.getByText('No hay partidas en curso.')).toBeAttached();
    const row = page.getByRole('article').filter({has:page.getByRole('heading',{name:tableName})});
    await expect(row.getByText('Esperando al rival MCP')).toBeVisible();
    await expect(row.getByRole('button',{name:'Cerrar',exact:true})).toBeVisible();
    const layout = await row.evaluate(article => {
      const elements = [...article.querySelectorAll('h3,p,li,[role=status],button')];
      const boxes = elements.map(element=>element.getBoundingClientRect());
      const edge = article.getBoundingClientRect();
      const overlaps = boxes.some((a,i)=>boxes.slice(i+1).some(b=>Math.min(a.right,b.right)-Math.max(a.left,b.left)>1
        && Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top)>1));
      return {
        within:boxes.every(b=>b.width>0 && b.left>=edge.left-1 && b.right<=edge.right+1 && b.right<=window.innerWidth+1),
        overlaps, readable:[...article.querySelectorAll('h3,p')].every(el=>el.scrollWidth<=el.clientWidth+1),
        buttonRows:new Set([...article.querySelectorAll('button')].map(el=>Math.round(el.getBoundingClientRect().top))).size,
      };
    });
    expect(layout.within).toBe(true);
    expect(layout.overlaps).toBe(false);
    expect(layout.readable).toBe(true);
    if (viewport.width < 500) expect(layout.buttonRows).toBeGreaterThan(1);
    await expect(row.getByRole('button',{name:/invitación MCP externa/i})).toBeVisible();
    await expect(row.getByRole('button',{name:/ID de la mesa/i})).toBeVisible();
    await expect(row.getByRole('button',{name:/espectador/i})).toBeVisible();
    await expect(row.getByRole('button',{name:'Iniciar',exact:true})).toBeDisabled();
    if (viewport.width === 849) await page.screenshot({path:info.outputPath('lobby-849.png')});
    await row.screenshot({path:info.outputPath('owner-row-'+viewport.width+'.png')});
  });
}
