import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../connection';
import { useSession } from '../stores/session';
import { Button } from '../ui/Button';
import { Zone } from '../ui/Zone';
import type { RecoveryView } from '../../protocol/generated/views';

/** A durable participant link. Consent never reveals hands and never starts play before both players attach. */
export function RecoveryScreen() {
  const { matchId } = useParams();
  const connected = useSession((s) => s.phase === 'signedIn' && s.connection === 'open');
  const loginCount = useSession((s) => s.loginCount);
  const [matches, setMatches] = useState<RecoveryView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [agreement, setAgreement] = useState<{ matchId: string; revision: number; loginCount: number } | null>(null);
  const agreed = (row: RecoveryView) => agreement?.matchId === row.matchId
    && agreement?.revision === row.revision && agreement?.loginCount === loginCount;
  useEffect(() => {
    if (!connected) return;
    let active = true;
    async function refresh() {
      try {
        const rows = matchId ? [await api.recoveryStatus(matchId)] : await api.recoveryList();
        if (active) { setMatches(rows); setError(null); }
      } catch (e) { if (active) setError(e instanceof Error ? e.message : 'Recovery is unavailable'); }
    }
    void refresh();
    const timer = setInterval(() => void refresh(), 2000);
    return () => { active = false; clearInterval(timer); };
  }, [connected, matchId]);
  async function join(row: RecoveryView, agree: boolean) {
    if (!row.matchId || row.revision === undefined || busy) return;
    setBusy(true);
    try {
      const next = await api.recoveryJoin(row.matchId, row.revision, agree);
      if (agree) setAgreement({ matchId: row.matchId, revision: row.revision, loginCount });
      setMatches([next]); setError(null);
    } catch (e) { setError(e instanceof Error ? e.message : 'Recovery could not complete'); }
    finally { setBusy(false); }
  }
  return <Zone label="Private match recovery">
    <h1>Return to your match</h1>
    <p>Recovery uses the last durably confirmed boundary. Clocks stay paused during downtime and while both participants reconnect and agree.</p>
    {error && <p role="alert">{error}</p>}
    {!connected && <p>Reconnect to Playmat to check your reserved seat.</p>}
    {matches.map((row) => <article key={row.matchId}>
      <h2>Game {row.gameNumber} · {row.status}</h2>
      <p>{row.message}</p>
      {row.link && <p><Link to={row.link}>Stable participant link</Link></p>}
      {row.status === 'waiting' && <>
        <Button disabled={busy || agreed(row)} onClick={() => void join(row, true)}>I agree to this saved boundary</Button>
        {agreed(row) && <p role="status">Agreement saved. Waiting for the other reserved participant.</p>}
      </>}
      {row.status === 'live' && <>
        <Button disabled={busy} onClick={() => void join(row, false)}>Reconnect my seat</Button>
        {row.gameId && <p><Link to={`/game/${row.gameId}`}>Open the game</Link></p>}
        {row.phase === 'sideboard' && row.tableId && <p><Link to={`/build/${row.tableId}`}>Open sideboarding</Link></p>}
      </>}
      {row.status === 'failed' && <p role="alert">Recovery failed before a new game was ready. Ask the server operator to review this private match; do not create another recovery table.</p>}
      {row.status === 'unavailable' && <p role="alert">This checkpoint cannot be loaded on the current engine. Its private data has been retained.</p>}
    </article>)}
    {connected && !error && matches.length === 0 && <p>No matches are reserved to this account or agent seat.</p>}
  </Zone>;
}
