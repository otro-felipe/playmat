import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { ChevronDown, Download } from 'lucide-react';
import { useState } from 'react';
import { formatNumber, registerMessages, useT } from '../i18n';
import messages from '../i18n/en/replay';
import { useSession } from '../stores/session';
import { Button } from '../ui/Button';
import { HistoryOverview } from './HistoryOverview';
import { PracticeMatchRow } from './PracticeMatchRow';
import type { PracticeHistoryPage, PracticeStats } from './practiceHistory';
import styles from './PracticeHistory.module.css';

registerMessages(messages);

async function read<T>(path: string, params: URLSearchParams, signal: AbortSignal) {
  const response = await fetch(`/api/playtesting/${path}?${params}`, { signal });
  if (!response.ok) throw new Error('History request failed');
  return await response.json() as T;
}

export function PrivateHistoryScreen() {
  const account = useSession((state) => state.userName);
  return <AccountHistory key={account} account={account} />;
}

function AccountHistory({ account }: { account: string }) {
  const t = useT();
  const [format, setFormat] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [exportState, setExportState] = useState<'idle' | 'downloading' | 'error'>('idle');
  const history = useInfiniteQuery({
    queryKey: ['playtesting-history', account, format],
    initialPageParam: '',
    queryFn: ({ pageParam, signal }) => {
      const query = new URLSearchParams({ limit: '25' });
      if (format) query.set('format', format);
      if (pageParam) query.set('cursor', pageParam);
      return read<PracticeHistoryPage>('matches', query, signal);
    },
    getNextPageParam: (page) => page.cursor ?? undefined,
    enabled: !!account,
    refetchInterval: 15_000,
  });
  const stats = useQuery({
    queryKey: ['playtesting-stats', account, format],
    queryFn: ({ signal }) => read<PracticeStats>('stats', new URLSearchParams({ format }), signal),
    enabled: !!account,
    refetchInterval: 15_000,
  });
  const matches = (history.data?.pages ?? []).flatMap((page) => page.matches);
  const visibleGames = new Set(matches.flatMap((match) => match.games.filter((game) => game.replayAvailable).map((game) => game.gameId)));
  const selectedGames = selected.filter((id) => visibleGames.has(id));

  function changeFormat(value: string) {
    setSelected([]);
    setExportState('idle');
    setFormat(value);
  }

  function toggleGame(id: string) {
    setExportState('idle');
    setSelected((prior) => {
      const available = prior.filter((id) => visibleGames.has(id));
      if (available.includes(id)) return available.filter((game) => game !== id);
      return available.length < 10 ? [...available, id] : available;
    });
  }

  async function exportSelected() {
    setExportState('downloading');
    try {
      const response = await fetch('/api/playtesting/exports', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ gameIds: selectedGames }),
      });
      if (!response.ok) throw new Error('Export unavailable');
      const url = URL.createObjectURL(await response.blob());
      const download = document.createElement('a');
      download.href = url;
      download.download = 'playmat-replays.zip';
      download.click();
      setTimeout(() => URL.revokeObjectURL(url), 0);
      setExportState('idle');
    } catch {
      setExportState('error');
    }
  }

  return (
    <div className={styles.page}>
      <header className={styles.head}>
        <h1>{t('shell.nav.history')}</h1>
        <div className={styles.controls}>
          <label className={styles.filter}>
            <select aria-label={t('history.format')} value={format} onChange={(event) => changeFormat(event.target.value)}>
              <option value="">{t('history.formats')}</option>
              {['Standard', 'Pioneer', 'Modern'].map((value) => <option key={value}>{value}</option>)}
            </select>
            <ChevronDown size={14} aria-hidden="true" />
          </label>
          <Button size="sm" icon={<Download size={15} />} disabled={!selectedGames.length || exportState === 'downloading'} onClick={() => void exportSelected()}>
            {t('history.export')}{selectedGames.length > 0 && ` (${formatNumber(selectedGames.length)})`}
          </Button>
        </div>
      </header>
      {exportState === 'error' && <p role="alert">{t('history.exportError')}</p>}
      {stats.isError && <p role="alert">{t('history.statsError')}</p>}
      {stats.data && <HistoryOverview stats={stats.data} />}
      <section aria-labelledby="history-matches" className={styles.matches}>
        <h2 id="history-matches">{t('history.yourMatches')}</h2>
        {history.isPending && <p className={styles.empty}>{t('history.loading')}</p>}
        {history.isError && <p role="alert" className={styles.empty}>{t('history.error')}</p>}
        {history.isSuccess && !matches.length && <p className={styles.empty}>{t(format ? 'history.empty' : 'history.emptyAll')}</p>}
        {matches.length > 0 && <>
          <div className={styles.columnHeaders} aria-hidden="true">
            <span className={styles.date}>{t('history.date')}</span><span>{t('history.rival')}</span>
            <span className={styles.format}>{t('history.format')}</span><span>{t('history.result')}</span>
            <span className={styles.score}>{t('history.score')}</span>
          </div>
          <ul className={styles.list}>
            {matches.map((match) => <PracticeMatchRow key={match.id} match={match} account={account} selected={selectedGames} onSelect={toggleGame} />)}
          </ul>
        </>}
        {history.hasNextPage && <Button disabled={history.isFetchingNextPage} onClick={() => void history.fetchNextPage()}>{t('history.more')}</Button>}
      </section>
    </div>
  );
}
