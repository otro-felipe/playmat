import { expect, test, type Page } from '@playwright/test';
import { gameOver, importTestDeck } from './helpers/app';
import { qaAccount, setPrivateInput, signInPrivate, tableRow } from './helpers/private';

type ToolInput = Record<string, string | number>;
type Decision = {
  id: string;
  kind: string;
  choices: { id: string; label: string; type: string; card?: { name: string; types: string[] } }[];
};
type MatchState = {
  ownHand: { id: string; name: string }[];
  players: { name: string; handCount: number; battlefield: { name: string }[] }[];
  decision: Decision | null;
};
type DecisionEvent = { event: 'decision'; state: MatchState } | { event: 'timeout' | 'game_over' | 'unavailable' };

type NativeTool = { name: string };
interface NativeDocument extends Document {
  modelContext?: {
    getTools(): Promise<NativeTool[]>;
    executeTool(tool: NativeTool, input: string): Promise<unknown>;
  };
}

async function nativeTools(page: Page) {
  return page.evaluate(async () => {
    const context = (document as NativeDocument).modelContext;
    if (typeof context?.getTools !== 'function' || typeof context.executeTool !== 'function') {
      throw new Error('This Chromium context lacks the native WebMCP testing API.');
    }
    return (await context.getTools()).map((tool) => tool.name);
  });
}

async function invoke<T>(page: Page, name: string, input: ToolInput = {}): Promise<T> {
  await expect.poll(() => nativeTools(page), { message: `${name} must be registered through native WebMCP` }).toContain(name);
  return page.evaluate(async ({ name, input }) => {
    const context = (document as NativeDocument).modelContext!;
    const tool = (await context.getTools()).find((item) => item.name === name);
    if (!tool) throw new Error('The native tool went away before its invocation.');
    const result = await context.executeTool(tool, JSON.stringify(input));
    return typeof result === 'string' ? JSON.parse(result) : result;
  }, { name, input });
}

function submit(page: Page, decisionId: string, choiceId: string) {
  return invoke<{ submitted?: boolean; error?: string }>(page, 'submit_choice', { decisionId, choiceId });
}

async function leaveFixtureGame(guest: Page, path: string) {
  await guest.getByRole('button', { name: 'Game menu' }).click({ timeout: 5000 });
  await guest.getByRole('menuitem', { name: 'Leave the game' }).click({ timeout: 5000 });
  await guest.getByRole('dialog', { name: 'Leave this match?' }).getByRole('button', { name: 'Leave match' }).click({ timeout: 5000 });
  await guest.waitForURL((url) => url.pathname !== path, { timeout: 5000 });
}

const passiveChoice = /^(?:play first|keep|next|pass|go to .+|resolve|no attacks|no blocks)$/i;

async function whileHostPasses<T>(operation: Promise<T>, host: Page): Promise<T> {
  let settled = false;
  void operation.then(() => { settled = true; }, () => { settled = true; });
  while (!settled) {
    const action = host.getByRole('button', { name: passiveChoice }).filter({ visible: true })
      .and(host.locator(':enabled')).first();
    if (await action.isVisible()) await action.click({ timeout: 750 }).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 75));
  }
  return operation;
}

async function playGuestLand(host: Page, guest: Page): Promise<string> {
  let lastDecisionId: string | undefined;
  let kept = false;
  const limit = Date.now() + 45_000;
  while (Date.now() < limit) {
    const input: ToolInput = { timeoutMs: 1500 };
    if (lastDecisionId) input.afterDecisionId = lastDecisionId;
    const event = await whileHostPasses(invoke<DecisionEvent>(guest, 'wait_for_decision', input), host);
    if (event.event === 'timeout') continue;
    if (event.event !== 'decision') throw new Error('Guest match ended before a land was available.');
    const { decision, ownHand, players } = event.state;
    if (!decision) throw new Error('A decision event must include the current decision.');
    expect(decision.id).not.toBe(lastDecisionId);
    expect(players.every((player) => !('hand' in player) && !('topCard' in player))).toBe(true);
    lastDecisionId = decision.id;

    if (decision.kind === 'mulligan') {
      expect(ownHand).toHaveLength(7);
      expect(await invoke<DecisionEvent>(guest, 'wait_for_decision', { afterDecisionId: decision.id, timeoutMs: 100 }))
        .toMatchObject({ event: 'timeout' });
      const keep = decision.choices.find((choice) => /^keep$/i.test(choice.label));
      if (!keep) throw new Error('The opening-hand decision must include Keep.');
      expect((await submit(guest, decision.id, 'invalid-choice')).error).toBeTruthy();
      expect(await submit(guest, decision.id, keep.id)).toMatchObject({ submitted: true });
      expect((await submit(guest, decision.id, keep.id)).error).toBeTruthy();
      kept = true;
      continue;
    }

    const land = decision.kind === 'priority' && decision.choices.find((choice) => choice.card?.types.includes('LAND'));
    if (land && land.card) {
      expect(kept).toBe(true);
      expect(await submit(guest, decision.id, land.id)).toMatchObject({ submitted: true });
      return land.card.name;
    }
    const choice = decision.choices.find((item) => item.type === 'pass' || passiveChoice.test(item.label));
    if (choice) await submit(guest, decision.id, choice.id);
  }
  throw new Error('The guest never received a decision to play a legal land.');
}

const baseURL = process.env.PLAYMAT_PRIVATE_BASE_URL;

test.use({
  trace: 'off',
  video: 'off',
  screenshot: 'off',
  launchOptions: {
    executablePath: process.env.MAGE_CHROMIUM_EXECUTABLE,
    args: ['--enable-features=WebMCP,WebMCPTesting'],
  },
});

test.describe('Private Playmat with native WebMCP', () => {
  test.skip(!baseURL || process.env.PLAYMAT_NATIVE_WEBMCP !== '1', 'Opt in with a private QA server and native Chromium.');
  test.describe.configure({ retries: 0 });

  test('[PM-AC-04, PM-AC-08] a signed-in invited guest takes a seat and plays a land over native WebMCP', async ({ browser }) => {
    test.setTimeout(160_000);
    process.env.PLAYWRIGHT_NO_COPY_PROMPT = '1';
    const hostAccount = qaAccount('A');
    const guestAccount = qaAccount('B');
    if (hostAccount.username.toLowerCase() === guestAccount.username.toLowerCase()) {
      throw new Error('Private browser QA needs two different provisioned accounts.');
    }
    const origin = new URL(baseURL!).origin;
    const options = { baseURL: origin, locale: 'en-US', serviceWorkers: 'block' as const };
    const hostContext = await browser.newContext(options);
    const guestContext = await browser.newContext(options);
    hostContext.setDefaultTimeout(15_000);
    guestContext.setDefaultTimeout(15_000);
    const host = await hostContext.newPage();
    const guest = await guestContext.newPage();
    const tableName = `WebMCP QA ${Date.now()}`;
    const deckName = `Pioneer QA ${Date.now()}`;
    const row = tableRow(host, tableName);
    let fixtureGame: string | null = null;

    try {
      for (const [page, account] of [[host, hostAccount], [guest, guestAccount]] as const) {
        await signInPrivate(page, account);
        await importTestDeck(page, deckName, '60 Plains');
      }
      await host.getByRole('link', { name: 'Tables', exact: true }).click();
      await host.getByRole('button', { name: 'Host a table' }).click();
      const dialog = host.getByRole('dialog', { name: 'Host a table' });
      await dialog.getByLabel('Table name').fill(tableName);
      await dialog.getByLabel('Format').selectOption('Constructed - Pioneer');
      await dialog.getByLabel('Games to win').selectOption('2');
      await setPrivateInput(dialog.getByLabel('Invited player'), guestAccount.username);
      await dialog.getByRole('button', { name: 'Host', exact: true }).click();
      await expect(dialog).toBeHidden({ timeout: 25_000 });
      await expect(row.getByRole('button', { name: 'Start' })).toBeDisabled();

      await hostContext.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
      await row.getByRole('button', { name: 'Invite', exact: true }).click();
      await expect(host.getByText('Invite link copied', { exact: true })).toBeVisible();
      const invitation = new URL(await host.evaluate(() => navigator.clipboard.readText()));
      expect(invitation.origin === origin && !invitation.search && !invitation.hash).toBe(true);
      const tableId = /^\/join\/([\da-f-]{36})$/i.exec(invitation.pathname)?.[1];
      if (!tableId) throw new Error('Expected an invite for one private table.');

      await guest.goto(invitation.pathname);
      await guest.getByRole('combobox', { name: 'Deck', exact: true }).selectOption({ label: deckName });
      await expect(guest.getByLabel('Password', { exact: true })).toHaveCount(0);
      expect(await invoke(guest, 'join_match')).toEqual({ joined: true, tableId });
      await guest.waitForURL('**/tables');
      expect(await nativeTools(guest)).not.toContain('join_match');
      await expect(row.getByRole('list', { name: 'Seats' })).toContainText(guestAccount.username);
      await row.getByRole('button', { name: 'Start' }).click();
      await Promise.all([host.waitForURL(/\/game\//), guest.waitForURL(/\/game\//)]);
      fixtureGame = new URL(guest.url()).pathname;
      expect(new URL(host.url()).pathname).toBe(fixtureGame);

      await expect.poll(async () => (await invoke<MatchState>(guest, 'get_match_state')).players
        .some((player) => player.name === guestAccount.username)).toBe(true);
      const land = await playGuestLand(host, guest);
      await expect(host.locator('[data-label="Lands & permanents"]').getByRole('img', { name: land, exact: true })).toBeVisible();
      await whileHostPasses(leaveFixtureGame(guest, fixtureGame), host);
      await whileHostPasses(expect(gameOver(host).getByRole('heading', { name: 'Victory' })).toBeVisible(), host);
    } finally {
      try {
        if (fixtureGame && new URL(guest.url()).pathname === fixtureGame && !await gameOver(guest).isVisible()) {
          await whileHostPasses(leaveFixtureGame(guest, fixtureGame), host).catch(() => undefined);
        } else {
          const close = row.getByRole('button', { name: 'Close', exact: true });
          if (await close.isVisible()) await close.click({ timeout: 3000 }).catch(() => undefined);
        }
      } finally {
        await Promise.all([hostContext.close(), guestContext.close()]);
      }
    }
  });
});
