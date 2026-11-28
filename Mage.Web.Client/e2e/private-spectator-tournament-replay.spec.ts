import { expect, test, type Page } from '@playwright/test';
import { spectatorSnapshot } from './fixtures/spectatorSnapshot';

test.skip(process.env.VITE_PRIVATE_PLAYTESTING !== 'true', 'private playtesting routes');

const pairing = {
  a: 'Spectator Fixture with a Long Name', b: 'Another Long Fixture Alias', winsA: 2, winsB: 1,
  draws: 0, winner: 'a', reason: 'afk',
};

async function openReplay(page: Page) {
  await page.addInitScript(() => localStorage.setItem('playmat.settings', JSON.stringify({ locale: 'en', animations: false })));
  await page.route('**/api/playtesting/tournaments/**', route => {
    const url = new URL(route.request().url());
    const gameId = url.searchParams.get('gameId');
    if (gameId) return route.fulfill({ json: { ...spectatorSnapshot, gameId, revision: Number(url.searchParams.get('frame')),
      visibility: 'public-board', hands: {} } });
    return route.fulfill({ json: { officialResult: pairing, games: [{ gameId: 'first', gameNumber: 1, frameCount: 4 },
      { gameId: 'second', gameNumber: 2, frameCount: 1 }].map(game => ({ ...game, capture: { exportState: 'ready',
      terminalEvent: true, cause: null, outcome: 'a', lastBoard: { frame: game.frameCount - 1, turn: 4, status: 'finished' } } })) } });
  });
  await page.goto('/tournaments/sample/pairings/example/replay');
  await expect(page.getByRole('slider', { name: 'Replay position' })).toBeVisible();
}

for (const width of [1440, 1024, 768, 390, 320]) {
  test(`[CUP-AC-007] the replay toolbar fits in two rows at ${width}px`, async ({ page, baseURL }, info) => {
    expect(['127.0.0.1', 'localhost']).toContain(new URL(baseURL!).hostname);
    await page.setViewportSize({ width, height: 900 });
    await openReplay(page);
    const header = page.getByRole('banner');
    const top = [header.getByRole('link', { name: 'Back to tournament' }), header.getByRole('heading'),
      header.getByRole('combobox', { name: 'Game' }), header.getByRole('button', { name: 'Replay information' })];
    const transport = [header.getByRole('button', { name: 'Previous frame' }), header.getByRole('button', { name: 'Play', exact: true }),
      header.getByRole('button', { name: 'Next frame' }), header.getByRole('slider'), header.getByRole('combobox', { name: 'Playback speed' })];
    const box = async (locator: (typeof top)[number]) => {
      await expect(locator).toBeVisible();
      return (await locator.boundingBox())!;
    };
    const first = await Promise.all(top.map(box));
    const second = await Promise.all(transport.map(box));
    const center = ({ y, height }: { y: number; height: number }) => y + height / 2;
    for (const item of first) expect(Math.abs(center(item) - center(first[0]))).toBeLessThan(2);
    for (const item of second) expect(Math.abs(center(item) - center(second[0]))).toBeLessThan(2);
    expect(center(second[0])).toBeGreaterThan(center(first[0]));
    if (width <= 390) for (const control of [...first.filter((_, i) => i !== 1), ...second]) expect(control.height).toBeGreaterThanOrEqual(44);
    expect(await header.evaluate(element => element.scrollWidth)).toBeLessThanOrEqual(width);
    expect(await header.getByRole('link', { name: 'Back to tournament' }).getAttribute('href')).toBe('/tournaments/sample');
    await expect(header.getByText(/Disqualification for inactivity/)).toHaveCount(0);
    await header.screenshot({ path: info.outputPath('replay-toolbar.png'), animations: 'disabled' });
    if (width === 390) {
      const info = header.getByRole('button', { name: 'Replay information' });
      await info.focus();
      await info.press('Enter');
      const dialog = page.getByRole('dialog', { name: 'Table result' });
      const result = dialog.getByRole('region', { name: 'Official match result' });
      await expect(result.getByText('Disqualification for inactivity')).toBeVisible();
      await expect(dialog.getByRole('button', { name: 'Close' })).toBeFocused();
      const game = dialog.getByRole('list', { name: 'Games of the table' }).getByRole('listitem').filter({
        has: page.getByRole('button', { name: 'Game 1', exact: true }),
      });
      const recordedEnding = game.getByText(/Game-ending event recorded/);
      await expect(recordedEnding).toBeHidden();
      await game.getByText('Full recording', { exact: true }).click();
      await expect(recordedEnding).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
      await expect(info).toBeFocused();
    }
  });
}

test('[CUP-AC-007] the replay respects speed, boundaries, keyboard seeks and game changes', async ({ page }) => {
  await openReplay(page);
  const header = page.getByRole('banner');
  const slider = header.getByRole('slider');
  const speed = header.getByRole('combobox', { name: 'Playback speed' });
  const previous = header.getByRole('button', { name: 'Previous frame' });
  const next = header.getByRole('button', { name: 'Next frame' });
  const play = header.getByRole('button', { name: 'Play', exact: true });
  await expect(slider).toHaveValue('0');
  await expect(speed).toHaveValue('1');
  await expect(previous).toBeDisabled();
  await next.click();
  await expect(slider).toHaveValue('1');
  await slider.press('End');
  await expect(slider).toHaveValue('3');
  await expect(next).toBeDisabled();
  await previous.click();
  await expect(slider).toHaveValue('2');
  await slider.press('Home');
  await expect(slider).toHaveValue('0');

  await page.clock.install();
  await play.click();
  await page.clock.runFor(750);
  await expect(slider).toHaveValue('0');
  await speed.selectOption('2');
  await page.clock.runFor(560);
  await expect(slider).toHaveValue('1');
  await slider.press('ArrowRight');
  await expect(play).toBeVisible();
  await expect(slider).toHaveValue('2');
  await play.click();
  await page.clock.runFor(650);
  await expect(slider).toHaveValue('3');
  await expect(play).toBeVisible();
  await play.click();
  await expect(slider).toHaveValue('0');
  await header.getByRole('combobox', { name: 'Game' }).selectOption({ label: 'Game 2' });
  await expect(play).toBeDisabled();
  await expect(slider).toBeDisabled();
  await expect(speed).toHaveValue('2');
});
