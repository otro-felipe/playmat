const RETURN_KEY = 'playmat.signup.return';
const RETURN_LIFETIME_MS = 30 * 60_000;
const MATCH_PATH = /^\/join\/[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

/** Verification email commonly opens a new tab, so a pending match return is shared across browser tabs. */
export function rememberSignupReturn(next: string | null) {
  try {
    if (next && MATCH_PATH.test(next)) {
      window.localStorage.setItem(RETURN_KEY, JSON.stringify({ next, expires: Date.now() + RETURN_LIFETIME_MS }));
    } else {
      window.localStorage.removeItem(RETURN_KEY);
    }
  } catch {
    // Signup still works when storage is disabled.
  }
}

export function takeSignupReturn(): string {
  try {
    const value = window.localStorage.getItem(RETURN_KEY);
    window.localStorage.removeItem(RETURN_KEY);
    const pending = value ? JSON.parse(value) : null;
    if (pending && typeof pending.next === 'string' && MATCH_PATH.test(pending.next) && pending.expires > Date.now()) {
      return pending.next;
    }
  } catch {
    // Missing or unusable storage means there is no match to return to.
  }
  return '/';
}
