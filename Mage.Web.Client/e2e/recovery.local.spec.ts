import { expect, test } from '@playwright/test';

const matchId = process.env.PLAYMAT_RECOVERY_UI_MATCH;
test.skip(!matchId || process.env.PLAYMAT_RECOVERY_UI_LOCAL !== 'yes', 'Explicit isolated recovery fixture only');

test('a real browser shows the confirmed boundary and submits one explicit participant agreement', async ({ page, baseURL }) => {
  if (!baseURL || !['127.0.0.1', 'localhost', 'playmat-recovery-local'].includes(new URL(baseURL).hostname)) {
    throw new Error('The recovery UI test must target the isolated local fixture');
  }
  const calls: string[] = [];
  page.on('websocket', (socket) => socket.on('framesent', (event) => {
    try {
      const frame = JSON.parse(String(event.payload));
      if (typeof frame.method === 'string') calls.push(frame.method);
    } catch { /* heartbeat frames are not RPC calls */ }
  }));
  const originalTable = process.env.PLAYMAT_RECOVERY_UI_ORIGINAL_TABLE;
  await page.goto('/login?next=' + encodeURIComponent(originalTable ? '/join/' + originalTable : '/recover/' + matchId));
  await page.locator('[name="username"]').fill('RecoveryAlice');
  await page.locator('[name="password"]').fill('isolated-recovery-fixture-only');
  await page.locator('button[type="submit"]').click();
  if (originalTable) {
    const recovery = page.getByRole('link', { name: 'Return to this match from its confirmed saved boundary' });
    await expect(recovery).toHaveAttribute('href', '/recover/' + matchId);
    await recovery.click();
  }
  await expect(page.getByRole('heading', { name: 'Return to your match' })).toBeVisible();
  await expect(page.getByText(/last durably confirmed turn/)).toBeVisible();
  expect(calls).not.toContain('recoveryJoin');
  await page.getByRole('button', { name: 'I agree to this saved boundary' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Agreement saved' })).toBeVisible();
  expect(calls.filter((method) => method === 'recoveryJoin')).toHaveLength(1);
  await page.screenshot({ path: '../.local/recovery-consent.png', fullPage: true });
});
