// @vitest-environment happy-dom
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { createFakeConnection, type FakeConnection } from '../../test/fakeConnection';

const SERVER = 'ws://server:17172';

async function load() {
  const { useSession } = await import('./session');
  const social = await import('./social');
  return { useSession, ...social, fake: (await import('../connection')) as unknown as FakeConnection };
}

function usePrivateBuild() {
  vi.doMock('../playtesting', () => ({ PRIVATE_PLAYTESTING: true }));
}

beforeEach(() => {
  vi.resetModules();
  vi.doMock('../connection', () => createFakeConnection());
  vi.doMock('../playtesting', () => ({ PRIVATE_PLAYTESTING: false }));
  localStorage.clear();
});

describe('social store', () => {
  test('keeps friends and ignored players apart, case-insensitively, and never lists yourself', async () => {
    const { useSession, useSocial, isFriend, isIgnored } = await load();
    useSession.setState({ userName: 'me', serverUrl: SERVER });
    const social = useSocial.getState();
    social.addFriend('Alice');
    social.addFriend('alice');
    social.addFriend('ME');
    expect(useSocial.getState().friends).toEqual(['Alice']);

    useSocial.getState().ignore('ALICE');
    expect(useSocial.getState().friends).toEqual([]);
    expect(isIgnored(useSocial.getState(), 'alice')).toBe(true);

    useSocial.getState().addFriend('alice');
    expect(isFriend(useSocial.getState(), 'Alice')).toBe(true);
    expect(useSocial.getState().ignored).toEqual([]);
  });

  test('remembers the lists per server', async () => {
    const { useSession, useSocial } = await load();
    useSession.setState({ serverUrl: SERVER, userName: 'me' });
    useSocial.getState().ignore('Troll');
    useSession.setState({ serverUrl: 'ws://other:17172' });
    expect(useSocial.getState().ignored).toEqual([]);
    useSession.setState({ serverUrl: SERVER });
    expect(useSocial.getState().ignored).toEqual(['Troll']);
  });

  test('tells the server the ignore list after each login and on every change', async () => {
    const { useSession, useSocial, fake } = await load();
    useSession.setState({ serverUrl: SERVER, userName: 'me' });
    useSocial.getState().ignore('Troll');
    // not signed in yet: nothing to send to
    expect(fake.api.chatSetIgnored).not.toHaveBeenCalled();

    await useSession.getState().signIn(SERVER, 'me', '');
    expect(fake.api.chatSetIgnored).toHaveBeenLastCalledWith(['Troll']);

    useSocial.getState().unignore('troll');
    expect(fake.api.chatSetIgnored).toHaveBeenLastCalledWith([]);
  });

  test('[PM-SETUP-AC-04] private lists follow the authenticated account and server', async () => {
    usePrivateBuild();
    const { useSession, useSocial, fake } = await load();
    await useSession.getState().signInWithSignOn(SERVER, 'Alice');
    useSocial.getState().addFriend('AliceFriend');
    useSocial.getState().ignore('AliceIgnored');
    expect(fake.api.chatSetIgnored).toHaveBeenLastCalledWith(['AliceIgnored']);

    useSession.setState({ phase: 'signedOut' });
    expect(useSocial.getState()).toMatchObject({ friends: [], ignored: [] });
    useSocial.getState().addFriend('SignedOutFriend');
    await useSession.getState().signInWithSignOn(SERVER, 'Bob');
    expect(useSocial.getState()).toMatchObject({ friends: [], ignored: [] });
    expect(fake.api.chatSetIgnored).toHaveBeenLastCalledWith([]);
    useSocial.getState().addFriend('BobFriend');

    await useSession.getState().signInWithSignOn(SERVER, 'ALICE');
    expect(useSocial.getState()).toMatchObject({ friends: ['AliceFriend'], ignored: ['AliceIgnored'] });
    expect(fake.api.chatSetIgnored).toHaveBeenLastCalledWith(['AliceIgnored']);
    await useSession.getState().signInWithSignOn('ws://other:17172', 'Alice');
    expect(useSocial.getState()).toMatchObject({ friends: [], ignored: [] });
    expect(fake.api.chatSetIgnored).toHaveBeenLastCalledWith([]);
    await useSession.getState().signInWithSignOn(SERVER, 'Bob');
    expect(useSocial.getState()).toMatchObject({ friends: ['BobFriend'], ignored: [] });
  });

  test('[PM-SETUP-AC-04] only the recorded private login inherits the old list', async () => {
    usePrivateBuild();
    localStorage.setItem('playmat.login', JSON.stringify({ serverUrl: SERVER, userName: 'Alice', account: true, signOn: true }));
    localStorage.setItem('playmat.social', JSON.stringify({ [SERVER]: { friends: ['OldFriend'], ignored: ['OldIgnored'] } }));
    const first = await load();
    expect(first.useSocial.getState()).toMatchObject({ friends: [], ignored: [] });
    await first.useSession.getState().signInWithSignOn(SERVER, 'Bob');
    expect(first.useSocial.getState()).toMatchObject({ friends: [], ignored: [] });

    vi.resetModules();
    const second = await load();
    await second.useSession.getState().signInWithSignOn(SERVER, 'Bob');
    expect(second.useSocial.getState()).toMatchObject({ friends: [], ignored: [] });
    await second.useSession.getState().signInWithSignOn(SERVER, 'Alice');
    expect(second.useSocial.getState()).toMatchObject({ friends: ['OldFriend'], ignored: ['OldIgnored'] });
    expect(second.fake.api.chatSetIgnored).toHaveBeenLastCalledWith(['OldIgnored']);
    second.useSocial.getState().removeFriend('OldFriend');
    second.useSocial.getState().unignore('OldIgnored');

    vi.resetModules();
    const third = await load();
    await third.useSession.getState().signInWithSignOn(SERVER, 'Alice');
    expect(third.useSocial.getState()).toMatchObject({ friends: [], ignored: [] });
  });

  test('[PM-SETUP-AC-04] an old list with no recorded owner stays outside all accounts', async () => {
    usePrivateBuild();
    const { DEFAULT_SERVER_URL } = (await import('../connection'));
    const legacy = JSON.stringify({ [DEFAULT_SERVER_URL]: { friends: ['OldFriend'], ignored: [] } });
    localStorage.setItem('playmat.social', legacy);
    const first = await load();
    await first.useSession.getState().signInWithSignOn(DEFAULT_SERVER_URL, 'Bob');
    expect(first.useSocial.getState().friends).toEqual([]);
    vi.resetModules();
    const second = await load();
    await second.useSession.getState().signInWithSignOn(DEFAULT_SERVER_URL, 'Bob');
    expect(second.useSocial.getState().friends).toEqual([]);
    expect(localStorage.getItem('playmat.social')).toBe(legacy);
  });
});
