import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { registerMessages, useT } from '../i18n';
import messages from '../i18n/en/events';
import { request, tournamentApi, tournamentPath, type Tournament } from './tournamentApi';
import { clearTournamentPlaySeat, rememberTournamentPlaySeat, tournamentPlaySeat } from './tournamentPlaySeat';
import styles from './TournamentScreen.module.css';

registerMessages(messages);
const terminal = new Set(['finished', 'cancelled', 'eliminated', 'disqualified', 'absent']);
const denied = new Set([401, 403, 404]);

/** Only an explicit play link opens an authenticated engine tab. All management and spectator routes stay read-only here. */
export function TournamentSeatLauncher() {
  const { id = '' } = useParams();
  const t = useT();
  const navigate = useNavigate();
  const [problem, setProblem] = useState<'cup.playStorageError' | 'cup.playUnavailable' | 'cup.error' | null>(null);
  useEffect(() => {
    const abort = new AbortController();
    async function open() {
      const cup = await request<Tournament>(tournamentApi + '/' + encodeURIComponent(id), undefined, abort.signal);
      if (abort.signal.aborted) return;
      const username = cup.viewer?.accountName ?? cup.viewer?.username;
      const entrant = cup.participants.find((p) => p.kind === 'human' && cup.viewer?.entryIds?.includes(p.id));
      if (!username || !entrant || terminal.has(cup.status) || terminal.has(entrant.state)) {
        setProblem('cup.playUnavailable');
        return;
      }
      try {
        rememberTournamentPlaySeat({ tournamentId: id, entryId: entrant.id, username });
      } catch {
        setProblem('cup.playStorageError');
        return;
      }
      const game = cup.pairings.find((p) => !p.completed && (p.a === entrant.id || p.b === entrant.id))?.playUrl;
      navigate(game && /^\/game\/[\w-]+$/.test(game) ? game : '/', { replace: true });
    }
    void open().catch(() => {
      if (!abort.signal.aborted) setProblem('cup.error');
    });
    return () => abort.abort();
  }, [id, navigate]);

  return (
    <main className={styles.page}>
      <div className={styles.inner}>
        <Link to={tournamentPath(id)}>{t('cup.public')}</Link>
        <p role="status">{t(problem ?? 'cup.loading')}</p>
      </div>
    </main>
  );
}

/** The engine shell survives lobby/game navigation. On reload the tab's own validated seat resumes. */
export function TournamentPlayTab({ username }: { username: string }) {
  useEffect(() => {
    const restored = tournamentPlaySeat();
    if (!restored) return;
    const seat = restored;
    if (username.toLowerCase() !== seat.username.toLowerCase()) {
      clearTournamentPlaySeat();
      return;
    }
    const abort = new AbortController();
    const signal = abort.signal;
    let timer: number | undefined;
    async function pulse() {
      try {
        // A login/logout in another tab can change the cookie while our engine tab is still open.
        const me = await fetch('/api/playtesting/me', { cache: 'no-store', signal });
        if (denied.has(me.status)) {
          clearTournamentPlaySeat();
          return;
        }
        if (me.ok) {
          const identity = await me.json();
          if (identity.agent || String(identity.engineName).toLowerCase() !== username.toLowerCase()) {
            clearTournamentPlaySeat();
            return;
          }
          const response = await fetch(tournamentApi + '/' + encodeURIComponent(seat.tournamentId) + '/wait', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}',
            cache: 'no-store',
            signal,
          });
          if (denied.has(response.status)) {
            clearTournamentPlaySeat();
            return;
          }
          if (response.ok) {
            const next = await response.json();
            if (next.entryId !== seat.entryId || terminal.has(next.status)) {
              clearTournamentPlaySeat();
              return;
            }
          }
        }
      } catch {
        /* temporary network failures retry while this game tab remains open */
      }
      if (!signal.aborted) timer = window.setTimeout(pulse, 10_000);
    }
    void pulse();
    return () => {
      abort.abort();
      window.clearTimeout(timer);
    };
  }, [username]);
  return null;
}
