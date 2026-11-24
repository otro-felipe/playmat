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
        { id: 'a', name: 'Crisol' }, { id: 'b', name: 'Vera Umbría' },
        { id: 'c', name: 'Ciro Centella' }, { id: 'd', name: 'Áurea' },
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
    const liveBox = await watch.boundingBox();
    const replayBox = await replays.first().boundingBox();
    expect(liveBox).not.toBeNull();
    expect(replayBox).not.toBeNull();
    expect(liveBox!.height).toBeGreaterThanOrEqual(44);
    expect(replayBox!.height).toBeGreaterThanOrEqual(44);
    expect(Math.max(replayBox!.x - liveBox!.x - liveBox!.width, replayBox!.y - liveBox!.y - liveBox!.height))
      .toBeGreaterThanOrEqual(8);
    expect(await watch.evaluate(link => getComputedStyle(link).textDecorationLine)).toBe('none');
    await watch.focus();
    await page.keyboard.press('Tab');
    await expect(replays.first()).toBeFocused();
    await expect(page.getByText('2 – 1', { exact: true })).toBeVisible();
    expect(await page.locator('main').evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
    if (width === 390) {
      const rosterTab = await page.getByRole('button', { name: 'Participants', exact: true }).boundingBox();
      const panel = await page.getByRole('heading', { name: 'Round tables' }).locator('../..').boundingBox();
      expect(panel!.y - rosterTab!.y - rosterTab!.height).toBeLessThanOrEqual(20);
    }
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(new RegExp(live.replayUrl + '$'));
    await page.goBack();
    await watch.click();
    await expect(page).toHaveURL(new RegExp(live.watchUrl + '$'));
  });
}
