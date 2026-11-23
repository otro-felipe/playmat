import { expect, test } from '@playwright/test';
import { spectatorSnapshot, spectatorToken } from './fixtures/spectatorSnapshot';

test.skip(process.env.VITE_PRIVATE_PLAYTESTING !== 'true', 'private playtesting routes');
const message = 'Primera línea &amp; 🌿\n' + 'Una decisión de la mesa. '.repeat(12) + '\nÚltimo tramo 🦊.';
const explanation = [
  'Primera jugada del agente. Juego la tierra y paso al combate con una fuente de maná disponible.',
  'Ataco con la criatura que ya estaba en el campo. La que acaba de entrar se queda como bloqueadora para el próximo turno.',
  'Si el rival bloquea, esperaré a que los bloqueos estén declarados. Así podré elegir si uso el instantáneo con los objetivos que sigan en el campo.',
  'Si responde antes del combate, la línea se detiene en esa ventana. Miraré el nuevo objeto en la pila antes de decidir si lo dejo resolver.',
  'Para la segunda fase principal queda una jugada opcional. Dependerá de qué criaturas sobrevivan al combate y de qué tierras sigan enderezadas.',
  'Si no se produce ningún cambio y el rival pasa, cedo la prioridad hasta mi próximo robo. La carta robada abre una decisión nueva.',
  'Fin de la línea 🔚.',
].join('\n\n');

for (const width of [1440,390]) test(`real seat chat and a separate keyboard-accessible line dialog at ${width}px`, async ({page,baseURL},info) => {
  expect(['127.0.0.1','localhost']).toContain(new URL(baseURL!).hostname);
  await page.setViewportSize({width,height:width===390?844:960});
  await page.addInitScript(() => localStorage.setItem('playmat.settings', JSON.stringify({locale:'es',animations:false})));
  await page.route('**/api/playtesting/spectate/**', route => {
    if (route.request().url().endsWith('/events')) return route.fulfill({contentType:'text/event-stream',body:'retry: 30000\n\n'});
    const at=Date.now();
    return route.fulfill({json:{...spectatorSnapshot,visibility:'both-hands', chat:[
      {at:at-4,messageId:'old',playerName:'Bob',message:'Anterior'},
      {at:at-3,messageId:'alice',playerName:'Alice',message:'Mensaje de Alice'},
      {at:at-2,messageId:'bob',playerName:'Bob',message}
    ],lines:[{at,turn:3,lineId:'line',playerName:'Bob',playerId:'seat-b',audience:'public',explanation}]}});
  });
  await page.goto('/watch/'+spectatorToken);
  const bubble=page.locator('[data-object-id="seat-b"]').getByRole('status',{name:'Chat de mesa'});
  await expect(bubble).toHaveText(message,{useInnerText:true});
  await expect(bubble.getByText(/Último tramo/)).toBeVisible();
  expect(await bubble.evaluate(el=>{
    el.scrollTop=el.scrollHeight; const last=el.querySelector('span')!.lastChild!;
    const range=document.createRange();range.setStart(last,last.textContent!.length-1);range.setEnd(last,last.textContent!.length);
    const b=range.getBoundingClientRect(),clip=el.getBoundingClientRect();
    return b.bottom<=Math.min(clip.bottom,innerHeight)+2 && b.left>=0 && b.right<=innerWidth+1;
  })).toBe(true);
  await expect(page.locator('[data-object-id="seat-a"]').getByRole('status',{name:'Chat de mesa'})).toHaveText('Mensaje de Alice');
  expect(await bubble.locator('span').evaluate(el=>getComputedStyle(el).whiteSpace)).toBe('pre-wrap');
  await expect(bubble.getByText(/jugada del agente|Anterior/)).toHaveCount(0);
  await page.getByRole('button',{name:'Chat',exact:true}).click();
  const list=page.getByRole('complementary').getByRole('list');
  await expect(list.getByRole('listitem')).toHaveCount(4);
  const row=list.getByRole('listitem').nth(2);
  expect(await row.getByText(/Último tramo/).textContent()).toBe(message);
  const event=list.getByRole('button',{name:'El agente envió una línea de juego'});
  await expect(event.locator('svg')).toHaveCount(1);
  await expect(list.getByText(/Primera jugada del agente/)).toHaveCount(0);
  await event.focus(); await page.keyboard.press('Enter');
  const dialog=page.getByRole('dialog',{name:'El agente envió una línea de juego'});
  const body=dialog.getByText(/Fin de la línea/);
  await expect(body).toBeVisible(); expect(await body.textContent()).toBe(explanation);
  expect(await body.evaluate(el=>getComputedStyle(el).whiteSpace)).toBe('pre-wrap');
  await page.keyboard.press('Tab');
  expect(await dialog.evaluate(el=>el.contains(document.activeElement))).toBe(true);
  await page.screenshot({path:info.outputPath(`linea-${width}.png`),animations:'disabled'});
  expect(await body.evaluate(el=>{
    const scroll=el.parentElement!;scroll.scrollTop=scroll.scrollHeight;
    const last=el.lastChild!,range=document.createRange();
    range.setStart(last,last.textContent!.length-1);range.setEnd(last,last.textContent!.length);
    return range.getBoundingClientRect().bottom<=scroll.getBoundingClientRect().bottom+2;
  })).toBe(true);
  await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0); await expect(event).toBeFocused();
  await page.keyboard.press('Escape'); await expect(page.getByRole('button',{name:'Chat',exact:true})).toBeFocused();
});

test('opening an English broadcast directly provides both hand labels without loading a replay', async ({ page, baseURL }) => {
  expect(['127.0.0.1', 'localhost', '[::1]']).toContain(new URL(baseURL!).hostname);
  await page.addInitScript(() => localStorage.setItem('playmat.settings', JSON.stringify({ locale: 'en', animations: false })));
  await page.route('**/api/playtesting/spectate/**', route => route.request().url().endsWith('/events')
    ? route.fulfill({ contentType: 'text/event-stream', body: 'retry: 30000\n\n' })
    : route.fulfill({ json: spectatorSnapshot }));
  await page.goto('/watch/' + spectatorToken);
  await expect(page.getByRole('group', { name: 'Bob’s hand' })).toBeVisible();
  await expect(page.getByRole('list', { name: 'Alice’s hand' })).toBeVisible();
});
