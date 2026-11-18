// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { createFakeConnection, type FakeConnection } from '../test/fakeConnection';

const SERVER = 'wss://private.test/ws';
beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  vi.doMock('./connection', () => ({ ...createFakeConnection(), DEFAULT_SERVER_URL: SERVER }));
  vi.doMock('./playtesting', () => ({ PRIVATE_PLAYTESTING: true }));
});
afterEach(() => vi.unstubAllGlobals());

test('one background connection uses the cookie identity and never the remembered XMage credentials', async () => {
  localStorage.setItem('playmat.login', JSON.stringify({ serverUrl: SERVER, userName: 'OtherAccount', account: true }));
  localStorage.setItem('playmat.remember', JSON.stringify({ serverUrl: SERVER, userName: 'OtherAccount', token: 'old-device-token' }));
  let release!: (value: Response) => void;
  const fetcher = vi.fn(() => new Promise<Response>((resolve) => { release = resolve; }));
  vi.stubGlobal('fetch', fetcher);
  const { api } = await import('./connection') as unknown as FakeConnection;
  api.serverInfo.mockResolvedValue({ signOn: 'Alice' });
  api.connectUser.mockResolvedValue(true);
  api.sessionUserName.mockResolvedValue('Alice');
  api.serverGetMainRoomId.mockResolvedValue('room');
  const { connectPrivateSession } = await import('./privateSessionConnect');
  const first = connectPrivateSession();
  expect(connectPrivateSession()).toBe(first);
  expect(api.connectUser).not.toHaveBeenCalled();
  release(Response.json({ accountId: 'cookie-account', engineName: 'Alice', agent: false }));
  await first;
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(api.connectUser).toHaveBeenCalledExactlyOnceWith('Alice', '', '');
  const { useSession } = await import('./stores/session');
  expect(useSession.getState()).toMatchObject({ phase: 'signedIn', userName: 'Alice' });
});

test.each([
  [401, { engineName: 'Alice' }, 'Alice'],
  [503, {}, 'Alice'],
  [200, { engineName: 'Alice', agent: true }, 'Alice'],
  [200, { engineName: 'Alice' }, 'SomeoneElse'],
])('a rejected or mismatched identity never signs in (%s, %j)', async (status, identity, signOn) => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(identity, { status })));
  const { api } = await import('./connection') as unknown as FakeConnection;
  api.serverInfo.mockResolvedValue({ signOn });
  const { connectPrivateSession } = await import('./privateSessionConnect');
  await expect(connectPrivateSession()).rejects.toThrow();
  expect(api.connectUser).not.toHaveBeenCalled();
});
