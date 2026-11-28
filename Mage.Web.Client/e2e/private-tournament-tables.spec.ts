import { expect, test } from '@playwright/test';

test.skip(process.env.VITE_PRIVATE_PLAYTESTING !== 'true', 'private build only');

for (const width of [1440, 390]) {
  test(`[CUP-AC-001] table actions stay clear and lead to the authorized destinations (${width}px)`, async ({ page }) => {
    await page.setViewportSize({ width, height: 960 });
    const live = {
      id: 'pair1', roundNumber: 1, stage: 'swiss', number: 1, a: 'a', b: 'b',
      tableId: 'table1', completed: false, winsA: 0, winsB: 0, draws: 0,
      watchUrl: '/tournaments/cup/pairings/pair1/watch', replayUrl: '/tournaments/cup/pairings/pair1/replay',
    };
    const finished = {
      ...live, id: 'pair2', number: 2, a: 'c', b: 'd', completed: true, winsA: 2, winsB: 1,
      replayUrl: '/tournaments/cup/pairings/pair2/replay',
    };
    const cup = {
      id: 'cup', name: 'Friday Cup', format: 'Pioneer', template: 'attendance', status: 'playing',
      stage: 'swiss', roundNumber: 1, roundsTotal: 3, cutSize: 0, cut: 'none',
      viewer: { isAdmin: true },
      participants: [
        { id: 'a', name: 'Crisol', provider: 'openai', model: 'gpt-6.2-sol' },
        { id: 'b', name: 'Vera Umbría', provider: 'claude', model: 'claude-opus-5-5' },
        { id: 'c', name: 'Ciro Centella', provider: 'gemini', model: 'gemini-pro' },
        { id: 'd', name: 'Áurea' },
      ].map(entry => ({ ...entry, owner: 'Felipe', kind: 'agent', state: 'active', online: true })),
      standings: [], pairings: [live, finished], deckLists: [],
    };
    await page.route('**/api/playtesting/**', (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith('/events'))
        return route.fulfill({ contentType: 'text/event-stream', body: ': keepalive\n\n' });
      return route.fulfill({ json: path.endsWith('/tournaments/cup') ? cup : { games: [] } });
    });

    await page.goto('/tournaments/cup');
    const watch = page.getByRole('link', { name: 'Watch live', exact: true });
    const replays = page.getByRole('link', { name: 'Full replay', exact: true });
    await expect(watch).toHaveCount(1);
    await expect(replays).toHaveCount(2);
    await expect(watch).toHaveAttribute('href', live.watchUrl);
    await expect(replays.first()).toHaveAttribute('href', live.replayUrl);
    await expect(replays.last()).toHaveAttribute('href', finished.replayUrl);
    // PM-MCP-PLAYER-VIEW-MODEL: all published marks load alongside their model in the table card.
    const tables = page.getByRole('region', { name: 'Round tables' });
    for (const [table, provider, model] of [
      ['Table 1', 'OpenAI', 'gpt-6.2-sol'],
      ['Table 1', 'Claude', 'claude-opus-5-5'],
      ['Table 2', 'Gemini', 'gemini-pro'],
    ]) {
      const card = tables.getByRole('listitem', { name: table });
      const badge = card.getByRole('img', { name: provider });
      await expect(badge).toBeVisible();
      await expect(card.getByText(model, { exact: true })).toBeVisible();
      await expect.poll(() => badge.evaluate(image => image instanceof HTMLImageElement ? image.naturalWidth : 0)).toBeGreaterThan(0);
    }
    await expect(tables.getByRole('img')).toHaveCount(3);
    const liveBox = await watch.boundingBox();
    const replayBox = await replays.first().boundingBox();
    expect(liveBox).not.toBeNull();
    expect(replayBox).not.toBeNull();
    expect(liveBox!.height).toBeGreaterThanOrEqual(44);
    expect(replayBox!.height).toBeGreaterThanOrEqual(44);
    expect(Math.max(liveBox!.x - replayBox!.x - replayBox!.width, liveBox!.y - replayBox!.y - replayBox!.height))
      .toBeGreaterThanOrEqual(8);
    expect(await watch.evaluate(link => getComputedStyle(link).textDecorationLine)).toBe('none');
    await replays.first().focus();
    await page.keyboard.press('Tab');
    await expect(watch).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(replays.first()).toBeFocused();
    await expect(tables.getByRole('listitem', { name: 'Table 2' }).getByText('2 – 1', { exact: true })).toBeVisible();
    expect(await page.locator('main').evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
    if (width === 390) {
      const panelGap = await tables.evaluate(section => {
        const previous = section.previousElementSibling!.getBoundingClientRect();
        return section.getBoundingClientRect().top - previous.bottom;
      });
      expect(panelGap).toBeGreaterThanOrEqual(0);
      expect(panelGap).toBeLessThanOrEqual(20);
    }
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(new RegExp(live.replayUrl + '$'));
    await page.goBack();
    await watch.click();
    await expect(page).toHaveURL(new RegExp(live.watchUrl + '$'));
  });
}
