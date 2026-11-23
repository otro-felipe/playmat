import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useT } from '../i18n';
import { Countdown } from './Countdown';
import { registerMessages } from '../i18n';
import messages from '../i18n/en/events';
import { request, tournamentApi, tournamentPath } from './tournamentApi';
import styles from './TournamentScreen.module.css';

registerMessages(messages);

type TableClock = { tournamentId: string; roundNumber: number; deadlineAt?: number | null } | null;
export function TournamentGameClock({ tableId }: { tableId: string }) {
  const t = useT();
  const clock = useQuery<TableClock>({
    queryKey: ['tournament-table-clock', tableId],
    retry: false,
    refetchInterval: (query) => (query.state.data ? 15_000 : false),
    queryFn: ({ signal }) => request<TableClock>(tournamentApi + '/table/' + encodeURIComponent(tableId), undefined, signal),
  });
  if (!clock.data?.tournamentId) return null;
  return (
    <aside className={styles.matchClock}>
      <Link to={tournamentPath(clock.data.tournamentId)} target="_blank" rel="noopener">
        {t('cup.number', { n: clock.data.roundNumber })}
      </Link>
      {clock.data.deadlineAt && <Countdown at={clock.data.deadlineAt} expired={t('cup.extraTurns')} />}
    </aside>
  );
}
