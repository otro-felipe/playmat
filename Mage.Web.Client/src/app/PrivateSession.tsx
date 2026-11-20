import { useEffect, useState, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useSession } from './stores/session';
import { useT } from './i18n';
import { Button } from './ui/Button';
import { Mark } from './ui/Mark';
import styles from './PrivateSession.module.css';
import { connectPrivateSession, SignInRequired } from './privateSessionConnect';

/** A background engine connection, with recovery controls only when something needs the player. */
export function PrivateSession({ anonymousHome }: { anonymousHome?: ReactNode } = {}) {
  const t = useT();
  const location = useLocation();
  const navigate = useNavigate();
  const elsewhere = useSession((state) => state.signedInElsewhere);
  const [attempt, setAttempt] = useState(0);
  const [anonymous, setAnonymous] = useState(false);
  const canShowLanding = location.pathname === '/' && anonymousHome != null;
  const [failed, setFailed] = useState(false);
  const [takingBack, setTakingBack] = useState(false);
  useEffect(() => {
    if (elsewhere && !takingBack) return;
    let cancelled = false;
    void connectPrivateSession().then(() => {
      if (cancelled) return;
      if (location.pathname === '/login' || location.pathname === '/join') {
        const from = (location.state as { from?: string } | null)?.from;
        navigate(from?.startsWith('/') && !from.startsWith('//') && !from.startsWith('/login') ? from : '/', { replace: true });
      }
    }).catch((error) => {
      if (cancelled) return;
      if (error instanceof SignInRequired) {
        if (canShowLanding) { setAnonymous(true); return; }
        const next = location.pathname === '/login' ? '/' : location.pathname + location.search + location.hash;
        window.location.replace('/login?next=' + encodeURIComponent(next));
      } else setFailed(true);
    });
    return () => { cancelled = true; };
  }, [attempt, elsewhere, takingBack, location.pathname, location.search, location.hash, location.state, navigate, canShowLanding]);
  if (canShowLanding && anonymous) return anonymousHome;
  const blocked = elsewhere && !takingBack;
  return <main className={styles.page}>
    <section className={styles.status} aria-labelledby="private-connect-title">
      <Mark size={48} />
      <h1 id="private-connect-title">{t(blocked ? 'login.private.elsewhere' : failed ? 'login.private.failed' : 'login.private.connecting')}</h1>
      <p role="status">{t(blocked ? 'login.private.elsewhereHint' : failed ? 'login.private.retryHint' : 'login.private.hint')}</p>
      {(blocked || failed) && <Button variant="decision" onClick={() => { setFailed(false); setTakingBack(true); setAttempt((value) => value + 1); }}>
        {t(blocked ? 'login.private.takeBack' : 'login.private.retry')}
      </Button>}
      {(blocked || failed) && <Button variant="quiet" onClick={() => void useSession.getState().signOut()}>{t('login.private.signOut')}</Button>}
    </section>
  </main>;
}
