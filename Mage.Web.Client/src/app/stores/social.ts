import { create } from 'zustand';
import { api } from '../connection';
import { PRIVATE_PLAYTESTING } from '../playtesting';
import { readJson, writeJson } from './persist';
import { rememberedSignOn, useSession, type SessionState } from './session';

/**
 * Browser-local friends and ignores belong to a server, and in private Playmat to the signed-in account.
 * The server receives the ignore list at login to filter chat, whispers and invites.
 */
interface SocialLists {
  friends: string[];
  ignored: string[];
}

const SOCIAL_KEY = 'playmat.social';
const ACCOUNT_SOCIAL_KEY = 'playmat.social.accounts';
export const MAX_IGNORED = 500;

interface SocialScope {
  serverUrl: string;
  accountKey: string | null;
}

interface SocialState extends SocialLists, SocialScope {
  addFriend(name: string): void;
  removeFriend(name: string): void;
  ignore(name: string): void;
  unignore(name: string): void;
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const without = (list: readonly string[], name: string) => list.filter((item) => !same(item, name));
const includes = (list: readonly string[], name: string) => list.some((item) => same(item, name));
const profileKey = (name: string) => 'account:' + name.toLowerCase();

type ServerLists = Record<string, SocialLists>;
type AccountLists = Record<string, ServerLists>;

export function isIgnored(state: SocialLists, name: string | null | undefined): boolean {
  return !!name && includes(state.ignored, name);
}

export function isFriend(state: SocialLists, name: string | null | undefined): boolean {
  return !!name && includes(state.friends, name);
}

function socialScope({ serverUrl, phase, userName }: SessionState): SocialScope {
  return {
    serverUrl,
    accountKey: PRIVATE_PLAYTESTING && phase === 'signedIn' && userName ? profileKey(userName) : null,
  };
}

function migratePrivateLists(serverUrl: string): void {
  const legacy = readJson<ServerLists>(SOCIAL_KEY, {})[serverUrl];
  if (!legacy) return;
  const accounts = readJson<AccountLists>(ACCOUNT_SOCIAL_KEY, {});
  if (Object.hasOwn(accounts, serverUrl)) return;
  const owner = rememberedSignOn?.serverUrl === serverUrl ? rememberedSignOn.userName : null;
  // An empty entry records that an ownerless legacy list cannot be adopted by a later login.
  accounts[serverUrl] = owner ? { [profileKey(owner)]: legacy } : {};
  writeJson(ACCOUNT_SOCIAL_KEY, accounts);
}

function load({ serverUrl, accountKey }: SocialScope): SocialLists {
  const saved = accountKey
    ? readJson<AccountLists>(ACCOUNT_SOCIAL_KEY, {})[serverUrl]?.[accountKey]
    : !PRIVATE_PLAYTESTING ? readJson<ServerLists>(SOCIAL_KEY, {})[serverUrl] : undefined;
  return { friends: saved?.friends ?? [], ignored: saved?.ignored ?? [] };
}

function save({ serverUrl, accountKey }: SocialScope, lists: SocialLists): void {
  if (accountKey) {
    const accounts = readJson<AccountLists>(ACCOUNT_SOCIAL_KEY, {});
    accounts[serverUrl] = { ...accounts[serverUrl], [accountKey]: lists };
    writeJson(ACCOUNT_SOCIAL_KEY, accounts);
    return;
  }
  const all = readJson<ServerLists>(SOCIAL_KEY, {});
  all[serverUrl] = lists;
  writeJson(SOCIAL_KEY, all);
}

function syncIgnored(ignored: string[]): void {
  if (useSession.getState().phase !== 'signedIn') return;
  // an older server without the call just keeps sending everything; the client still hides it
  api.chatSetIgnored(ignored).catch(() => undefined);
}

export const useSocial = create<SocialState>((set, get) => {
  const change = (next: Partial<SocialLists>) => {
    const state = get();
    if (PRIVATE_PLAYTESTING && !state.accountKey) return;
    const lists = { friends: next.friends ?? state.friends, ignored: next.ignored ?? state.ignored };
    save(state, lists);
    set(lists);
    if (next.ignored) syncIgnored(lists.ignored);
  };
  const myName = () => useSession.getState().userName;
  const scope = socialScope(useSession.getState());
  if (PRIVATE_PLAYTESTING) migratePrivateLists(scope.serverUrl);
  return {
    ...scope,
    ...load(scope),

    addFriend(name) {
      const trimmed = name.trim();
      if (!trimmed || same(trimmed, myName()) || isFriend(get(), trimmed)) return;
      change({ friends: [...get().friends, trimmed], ignored: isIgnored(get(), trimmed) ? without(get().ignored, trimmed) : undefined });
    },
    removeFriend(name) {
      if (isFriend(get(), name)) change({ friends: without(get().friends, name) });
    },
    ignore(name) {
      const trimmed = name.trim();
      if (!trimmed || same(trimmed, myName()) || isIgnored(get(), trimmed)) return;
      change({ ignored: [...get().ignored, trimmed].slice(-MAX_IGNORED), friends: isFriend(get(), trimmed) ? without(get().friends, trimmed) : undefined });
    },
    unignore(name) {
      if (isIgnored(get(), name)) change({ ignored: without(get().ignored, name) });
    },
  };
});

useSession.subscribe((state, previous) => {
  const scope = socialScope(state);
  const current = useSocial.getState();
  if (scope.serverUrl !== current.serverUrl || scope.accountKey !== current.accountKey) {
    useSocial.setState({ ...scope, ...load(scope) });
  }
  // the server forgets the list with the session: send it after every login
  if (state.phase === 'signedIn' && state.loginCount !== previous.loginCount) {
    syncIgnored(useSocial.getState().ignored);
  }
});
